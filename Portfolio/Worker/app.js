/* Kujira Portfolio application logic.
   Extracted from index.html's inline <script> for CSP hardening (script-src
   drops 'unsafe-inline'). Loaded after Worker/kjr-core.js + kjr-sortable.js,
   same execution order as before. Inline event handlers are replaced by the
   delegated dispatcher in installEventDelegation(). */
/* ═══════════════════════════════════════════════════════════════════════
   KUJIRA PORTFOLIO — Finance Tracker
   Phase 1: skeleton, sync handshake, settings.
   Architecture mirrors Kujira Collectibles + Send Ops conventions.
   ═══════════════════════════════════════════════════════════════════════ */

// Keep APP_VERSION's major in step with APP_DISPLAY_VERSION: the first stamps
// backups/diagnostics/_meta, the second is the friendly topbar badge.
const APP_VERSION = 'v2.41';
const APP_DISPLAY_VERSION = 'v2.41 (3 Jul)';
const SCHEMA = 'kujira-portfolio';
/* Payload schema version. Increment when a breaking field rename or removal
   lands; add the migration fn to _MIGRATIONS in the DB section below. */
const SCHEMA_VERSION = 3;

/* Local storage keys */
const LK_DB        = 'kjr-pf-db-v1';
const LK_SYNC_URL  = 'kjr-pf-sync-url-v1';
const LK_SYNC_TS   = 'kjr-pf-sync-ts-v1';
const LK_LAST_PULL = 'kjr-pf-last-pull-v1';
const LK_LAST_PULL_SRC = 'kjr-pf-last-pull-src-v1';  // 'server' if from doGet._savedAt or doPost.savedAt, else 'client'
const LK_THEME     = 'kjr-pf-theme-v1';
const LK_PRIVACY   = 'kjr-pf-privacy-v1';   // blur all money figures (shoulder-surfing guard)
const LK_PRICE_CACHE = 'kjr-pf-price-cache-v1'; // persisted separately so first paint uses last-known prices

/* Sync constants. PAYLOAD_HARD_CAP is a soft cap now the backend chunks large
   payloads across sheet cells (Worker/apps-script.gs writePayloadRaw_), it no
   longer reflects a single cell's 50,000-char limit. Kept well under Apps
   Script's own request-size ceiling. PAYLOAD_WARN_AT stays at 80% of the cap. */
const SYNC_DEBOUNCE_MS = 800;
const PAYLOAD_HARD_CAP = 400000;
const PAYLOAD_WARN_AT  = Math.round(PAYLOAD_HARD_CAP * 0.8);

/* Auto-refresh: poll prices every 60s while the tab is visible.
   Crypto runs every tick (trades 24/7). Stocks only run Monday-Friday SGT
   (covers SGX local hours + US pre/regular/post hours). FX runs alongside
   stocks since it's the same underlying provider. */
const AUTO_REFRESH_INTERVAL_MS = 60 * 1000;
const LK_AUTO_REFRESH = 'kjr-pf-auto-refresh-v1';   // user can disable in Settings

/* CPF default rates (% p.a.) — Board rates as of 2026 */
const CPF_DEFAULTS = {
  OA: 2.5, SA: 4.08, MA: 4.08, RA: 4.08,
  extraFirst60k: 1.0,       // +1% on first S$60k of combined balances
  extraFirst30kAge55: 1.0   // additional +1% on first S$30k from age 55
};


/* Age (whole years) on a given ISO date, from birthYear. Coarse: uses the
   year difference only, since we store birth year not full DOB. */
function _ageOnYear(year){
  const by = DB.settings && DB.settings.birthYear;
  if (!by) return null;
  return Number(year) - Number(by);
}


/* The set of pay-months to generate for, bounded by the salary start, an
   optional end date, and today (never future). Returns [] when salary is
   not configured. */
function _salaryPayMonths(){
  const sal = DB.settings && DB.settings.salary;
  if (!sal || !sal.grossMonthly || !sal.startDate) return { sal:null, months:[] };
  const todayYM = _isoDate(new Date()).slice(0, 7);
  const startYM = sal.startDate.slice(0, 7);
  let endYM = sal.endDate ? sal.endDate.slice(0, 7) : todayYM;
  if (endYM > todayYM) endYM = todayYM;
  if (startYM > endYM) return { sal, months:[] };
  return { sal, months: _monthsBetween(startYM, endYM) };
}

/* ─── Auto-salary income entries ───────────────────────────────────────
   One income row per payday from salary start to today. Idempotent: keyed
   by (auto:'salary', period). Re-runs refresh amounts if the salary config
   changed, but never clobber an entry the user has edited (manualOverride). */
function generateAutoSalaryEntries(){
  const { sal, months } = _salaryPayMonths();
  if (!sal) return 0;
  if (!Array.isArray(DB.income)) DB.income = [];

  const byPeriod = {};
  DB.income.forEach(e => { if (e.auto === 'salary' && e.period) byPeriod[e.period] = e; });

  const today = _isoDate(new Date());
  let changed = 0;
  months.forEach(ym => {
    const [y, m] = ym.split('-').map(Number);
    const payday = getPayday(y, m);
    if (payday > today) return; // payday not reached
    const prev = byPeriod[ym];
    if (prev && prev.manualOverride) return; // user owns this row now

    const c = computeCpfContribution(sal.grossMonthly, _ageOnYear(y));
    const fields = {
      date:        payday,
      gross:       _round2(sal.grossMonthly),
      net:         c.net,
      employerCPF: c.employerCPF,
      employeeCPF: c.employeeCPF,
      source:      sal.employer || 'Salary',
      notes:       'Auto-generated from Settings',
      auto:        'salary',
      period:      ym
    };
    if (prev){
      const before = JSON.stringify(prev);
      Object.assign(prev, fields);
      if (JSON.stringify(prev) !== before) changed++;
    } else {
      DB.income.push(Object.assign({ id: uid('income') }, fields));
      changed++;
    }
  });
  return changed;
}

/* ─── Auto-CPF contribution entries ────────────────────────────────────
   For each salary payday, one cpfHistory contribution per account (OA/SA/MA)
   that receives a share. Idempotent: keyed by (auto:'cpf', period, account).
   Only runs for ages ≤55 (SA still open); skips 55+ until the OA/MA/RA split
   is automated. Respects manualOverride on individual rows. */
function generateAutoCpfEntries(){
  const { sal, months } = _salaryPayMonths();
  if (!sal) return { changed:0, skippedSenior:false };
  if (!Array.isArray(DB.cpfHistory)) DB.cpfHistory = [];

  const byKey = {};
  DB.cpfHistory.forEach(e => { if (e.auto === 'cpf' && e.period && e.account) byKey[e.period + '|' + e.account] = e; });

  // The typed CPF balance is an opening anchor that already bakes in every
  // contribution up to its date. Accrue only for paydays strictly after it,
  // so net worth grows forward without double-counting the statement figure.
  const anchor = _cpfAnchorDate();

  const today = _isoDate(new Date());
  let changed = 0, skippedSenior = false;
  months.forEach(ym => {
    const [y, m] = ym.split('-').map(Number);
    const payday = getPayday(y, m);
    if (payday > today) return;
    if (anchor && payday <= anchor) return;    // already inside the opening figure

    const c = computeCpfContribution(sal.grossMonthly, _ageOnYear(y));
    if (!c.allocated){ skippedSenior = true; return; }

    ['OA', 'SA', 'MA'].forEach(acct => {
      const amt = _round2(c.byAccount[acct] || 0);
      const key = ym + '|' + acct;
      const prev = byKey[key];
      if (prev && prev.manualOverride) return;
      if (amt <= 0){
        // No contribution for this account this month; nothing to create.
        return;
      }
      const fields = {
        date:    payday,
        type:    'contribution',
        account: acct,
        amount:  amt,
        source:  (sal.employer ? sal.employer + ' · ' : '') + _ymLabel(ym),
        notes:   'Auto-generated from salary',
        auto:    'cpf',
        period:  ym
      };
      if (prev){
        const before = JSON.stringify(prev);
        Object.assign(prev, fields);
        if (JSON.stringify(prev) !== before) changed++;
      } else {
        DB.cpfHistory.push(Object.assign({ id: uid('cpfHistory') }, fields));
        changed++;
      }
    });
  });

  // Drop any auto rows on/before the anchor (e.g. after the user re-enters a
  // newer statement). They are regenerable and already inside the typed
  // figure, so this is not user data loss. Manual edits are always kept.
  if (anchor){
    const before = DB.cpfHistory.length;
    DB.cpfHistory = DB.cpfHistory.filter(e => !(e.auto === 'cpf' && !e.manualOverride && String(e.date || '') <= anchor));
    changed += (before - DB.cpfHistory.length);
  }

  return { changed, skippedSenior };
}

/* ─── Auto CPF interest ────────────────────────────────────────────────
   Credits monthly interest on the running balance so the typed opening
   figure keeps growing on its own. Matches how CPF actually works: interest
   is computed MONTHLY on the lowest balance (this month's own contributions
   earn from next month), but credited ONCE A YEAR and compounded annually —
   it does NOT compound month to month. So we accumulate each year's monthly
   interest and post it as a single year-end credit per account, only for
   years that have fully ended. The current year's interest stays invisible
   until 31 Dec, exactly like the CPF statement. Base board rate per account,
   plus +1% on the first $60k of combined balances (OA capped at $20k in the
   pool) and +1% more on the first $30k from age 55; extra interest is paid
   into SA (under 55) or RA (55+), as CPF does. Fully derived — wiped and
   rebuilt each run, so a salary or rate change reactively re-flows. Keyed
   (auto:'cpfInt', period:'YYYY-12', account). Note: for an anchor set
   mid-year, that first part-year's credit only counts months after the
   anchor (pre-anchor monthly balances are unknown); re-anchoring against a
   fresh annual statement self-corrects. */
function _nextYM(ym){ let [y,m] = ym.split('-').map(Number); m++; if (m > 12){ m = 1; y++; } return y + '-' + String(m).padStart(2,'0'); }
function _lastDayOfMonthISO(y, m){ const d = new Date(y, m, 0).getDate(); return y + '-' + String(m).padStart(2,'0') + '-' + String(d).padStart(2,'0'); }

function generateAutoCpfInterest(){
  const anchor = _cpfAnchorDate();
  if (!anchor) return 0;                                   // need an opening anchor
  if (!Array.isArray(DB.cpfHistory)) DB.cpfHistory = [];
  const b = DB.cpfBalances || {};
  const opening = { OA:Number(b.OA)||0, SA:Number(b.SA)||0, MA:Number(b.MA)||0, RA:Number(b.RA)||0 };

  // Wipe prior auto interest after the anchor; rebuilt from scratch below.
  const startLen = DB.cpfHistory.length;
  DB.cpfHistory = DB.cpfHistory.filter(e => !(e.auto === 'cpfInt' && !e.manualOverride && String(e.date || '') > anchor));
  let changed = startLen - DB.cpfHistory.length;

  const anchorYM = anchor.slice(0,7);
  const today    = _isoDate(new Date());
  const firstYM  = _nextYM(anchorYM);
  // Whole months that have fully ended; a year is only credited once its
  // December is in this list (i.e. the year is genuinely over).
  const months = _monthsBetween(firstYM, today.slice(0,7))
    .filter(ym => { const [yy, mm] = ym.split('-').map(Number); return _lastDayOfMonthISO(yy, mm) <= today; });
  if (!months.length) return changed;

  const r   = DB.settings.cpfRates || {};
  const mo  = x => ((Number(x)||0) / 100) / 12;            // annual % -> monthly fraction
  const e60 = mo(r.extraFirst60k != null ? r.extraFirst60k : 1);
  const e30 = mo(r.extraFirst30kAge55 != null ? r.extraFirst30kAge55 : 1);

  // External (non-interest) movements per month after the anchor: auto salary
  // contributions and any manual top-ups. These are real principal and feed
  // the interest-earning base immediately (they just earn from next month).
  const ext = {};
  DB.cpfHistory.forEach(h => {
    if (h.auto === 'cpfInt') return;
    const d = String(h.date || '');
    if (d <= anchor) return;
    const ym = d.slice(0,7);
    (ext[ym] = ext[ym] || { OA:0, SA:0, MA:0, RA:0 });
    if (ext[ym][h.account] != null) ext[ym][h.account] += Number(h.amount) || 0;
  });

  // base = interest-earning principal: opening + contributions + interest
  // credited in PRIOR years. It deliberately excludes the current year's
  // accruing interest, so there is no month-to-month compounding within a year.
  const base = Object.assign({}, opening);
  if (ext[anchorYM]) ['OA','SA','MA','RA'].forEach(a => base[a] += ext[anchorYM][a] || 0);

  let yearAcc = { OA:0, SA:0, MA:0, RA:0 };                 // interest building up this calendar year

  months.forEach(ym => {
    const [y, m] = ym.split('-').map(Number);
    const age = _ageOnYear(y);
    // Monthly interest on the carried-in base (≈ lowest balance: excludes this
    // month's own contributions and the current year's accruing interest).
    ['OA','SA','MA','RA'].forEach(a => { yearAcc[a] = _round2(yearAcc[a] + (base[a]||0) * mo(r[a])); });

    // Extra interest (+1% on first $60k, +1% more on first $30k from 55). CPF
    // credits the extra earned on each account into THAT account, except OA's
    // extra which goes to SA (or RA from 55). The pool fills OA first (capped at
    // $20k), then SA, MA, RA. This apportions the extra per account rather than
    // dumping it all into one, so per-account balances track the statement. The
    // additional $30k band (55+) is credited wholly to RA per CPF rules.
    const oaInPool = Math.min(base.OA||0, 20000);
    let room = 60000;
    const takeFromPool = (bal) => { const t = Math.max(0, Math.min(bal||0, room)); room -= t; return t; };
    const poolOA = takeFromPool(oaInPool);
    const poolSA = takeFromPool(base.SA||0);
    const poolMA = takeFromPool(base.MA||0);
    const poolRA = takeFromPool(base.RA||0);
    const senior = (age != null && age >= 55);
    const oaExtraAcct = senior ? 'RA' : 'SA';   // OA's extra is never paid into OA
    yearAcc[oaExtraAcct] = _round2(yearAcc[oaExtraAcct] + poolOA * e60);
    yearAcc.SA = _round2(yearAcc.SA + poolSA * e60);
    yearAcc.MA = _round2(yearAcc.MA + poolMA * e60);
    yearAcc.RA = _round2(yearAcc.RA + poolRA * e60);
    if (senior){
      const pool = oaInPool + (base.SA||0) + (base.MA||0) + (base.RA||0);
      yearAcc.RA = _round2(yearAcc.RA + Math.min(pool, 30000) * e30);
    }

    // This month's contributions join the principal now (earn from next month).
    if (ext[ym]) ['OA','SA','MA','RA'].forEach(a => base[a] = (base[a]||0) + (ext[ym][a]||0));

    // Year-end: post the year's accumulated interest as one credit per account,
    // then fold it into the principal so it compounds into the next year.
    if (m === 12){
      const date = y + '-12-31';
      ['OA','SA','MA','RA'].forEach(a => {
        const amt = _round2(yearAcc[a]);
        if (amt <= 0) return;
        DB.cpfHistory.push({ id: uid('cpfHistory'), date, type:'interest', account:a,
          amount: amt, source:'CPF interest ' + y, notes:'Auto-generated annual interest', auto:'cpfInt', period: y + '-12' });
        changed++;
        base[a] = (base[a]||0) + amt;
      });
      yearAcc = { OA:0, SA:0, MA:0, RA:0 };
    }
  });
  // Any remaining yearAcc is the current, unfinished year — intentionally not
  // posted, so the balance only shows interest at year-end, like the statement.

  return changed;
}

/* ─── Auto salary deposit + discretionary split ────────────────────────
   When a salary account is set, each payday on/after salaryCashEnabledAt:
   deposit the SAVED share of take-home into that account, and log the rest
   as a 'Discretionary' expense (the part spent via an untracked account).
   Net worth grows by exactly the saved amount; the P&L savings rate reflects
   the true split. Idempotent: cash keyed (auto:'salaryCash', period+role),
   expense keyed (auto:'salaryCash', period). Never backfills before the
   enable date, so it cannot double-count the typed opening balance. Respects
   manualOverride on any row the user has since edited. */
function generateAutoSalaryCashEntries(){
  const { sal, months } = _salaryPayMonths();
  if (!sal) return 0;
  const s = DB.settings;
  const acctId = s.salaryAccountId;
  if (!acctId) return 0;                                   // automation off
  const acct = (DB.cash || []).find(c => c.id === acctId);
  if (!acct) return 0;                                     // account removed
  const enabledAt = s.salaryCashEnabledAt;
  if (!enabledAt) return 0;
  const savePct = Math.max(0, Math.min(100, Number(s.salarySavePct == null ? 50 : s.salarySavePct)));
  const acctCcy = acct.currency || 'SGD';

  // Optional spending account (e.g. UOB). When set, the FULL take-home lands in
  // the salary account, the non-saved share is transferred to the spending
  // account, then immediately withdrawn (assumed spent) so it nets to zero —
  // the money flow is visible without tracking individual purchases. When
  // unset, only the saved share is deposited.
  let discId = s.salaryDiscretionaryAccountId || '';
  const discAcct = discId ? (DB.cash || []).find(c => c.id === discId) : null;
  if (!discAcct || discId === acctId) discId = '';
  const useUob = !!discId;
  const discCcy = (discAcct && discAcct.currency) || 'SGD';

  if (!Array.isArray(DB.cashTxns)) DB.cashTxns = [];
  if (!Array.isArray(DB.expenses)) DB.expenses = [];
  const cashByKey = {}; DB.cashTxns.forEach(e => { if (e.auto === 'salaryCash' && e.period && e.role) cashByKey[e.period + '|' + e.role] = e; });
  const expByKey  = {}; DB.expenses.forEach(e => { if (e.auto === 'salaryCash' && e.period) expByKey[e.period] = e; });

  const today = _isoDate(new Date());
  let changed = 0;
  const keepKeys = {};   // period|role rows we (re)created this run
  const processed = {};

  const upsertCash = (ym, role, fields) => {
    keepKeys[ym + '|' + role] = true;
    const prev = cashByKey[ym + '|' + role];
    if (prev && prev.manualOverride) return;
    if (prev){ const b = JSON.stringify(prev); Object.assign(prev, fields); if (JSON.stringify(prev) !== b) changed++; }
    else { DB.cashTxns.push(Object.assign({ id: uid('cashTxns'), auto:'salaryCash', period:ym, role }, fields)); changed++; }
  };

  months.forEach(ym => {
    const [y, m] = ym.split('-').map(Number);
    const payday = getPayday(y, m);
    if (payday > today) return;        // payday not reached
    if (payday < enabledAt) return;    // before opt-in: leave to the opening balance
    processed[ym] = true;

    const c     = computeCpfContribution(sal.grossMonthly, _ageOnYear(y));
    const net   = _round2(c.net);
    const disc  = _round2(net - _round2(net * savePct / 100));
    const saved = _round2(net - disc);

    if (useUob){
      // 1) Full take-home into the salary account.
      if (net > 0)  upsertCash(ym, 'dep',   { type:'deposit',    cashAccountId:acctId, fromAccountId:'',     date:payday, amount:net,  currency:acctCcy, notes:'Salary take-home (auto)' });
      // 2) Move the spending share across to the spending account.
      if (disc > 0) upsertCash(ym, 'xfer',  { type:'transfer',   cashAccountId:discId, fromAccountId:acctId, date:payday, amount:disc, currency:acctCcy, notes:'To spending account (auto)' });
      // 3) Assume it is spent immediately, so the spending account nets to zero.
      if (disc > 0) upsertCash(ym, 'spend', { type:'withdrawal', cashAccountId:discId, fromAccountId:'',     date:payday, amount:disc, currency:discCcy, notes:'Discretionary — assumed spent (auto)' });
    } else {
      // No spending account: deposit only the saved share into the salary account.
      if (saved > 0) upsertCash(ym, 'save', { type:'deposit', cashAccountId:acctId, fromAccountId:'', date:payday, amount:saved, currency:acctCcy, notes:'Salary — saved ' + savePct + '% (auto)' });
    }

    // Discretionary expense (keeps the savings rate honest) — both modes.
    if (disc > 0){
      const prev = expByKey[ym];
      if (!(prev && prev.manualOverride)){
        const fields = { date:payday, amount:disc, currency:acctCcy, category:'Discretionary', subcategory:'',
          merchant: useUob ? (discAcct.name || 'Spending') : 'Untracked', notes:'Auto: non-saved share of take-home',
          auto:'salaryCash', period:ym, role:'disc' };
        if (prev){ const b = JSON.stringify(prev); Object.assign(prev, fields); if (JSON.stringify(prev) !== b) changed++; }
        else { DB.expenses.push(Object.assign({ id: uid('expenses') }, fields)); changed++; }
      }
    }
  });

  // Prune stale auto cash rows for processed months whose role we didn't recreate
  // (e.g. after switching the spending account on/off). Manual edits are kept.
  const before = DB.cashTxns.length;
  DB.cashTxns = DB.cashTxns.filter(e =>
    !(e.auto === 'salaryCash' && processed[e.period] && !e.manualOverride && !keepKeys[e.period + '|' + e.role]));
  changed += (before - DB.cashTxns.length);

  return changed;
}

/* Run both generators, persist if anything changed, and surface a note if
   55+ CPF was skipped. Safe to call on boot and after a salary save. */
let _seniorCpfNoticeShown = false;
function runSalaryEngine(opts){
  opts = opts || {};
  const incomeChanged = generateAutoSalaryEntries();
  const cpf = generateAutoCpfEntries();
  const cpfIntChanged = generateAutoCpfInterest();   // after contributions: interest compounds on them
  const cashChanged = generateAutoSalaryCashEntries();
  if (incomeChanged || cpf.changed || cpfIntChanged || cashChanged){
    saveData();
    if (opts.rerender) renderAll();
  }
  if (cpf.skippedSenior && opts.notify && !_seniorCpfNoticeShown){
    _seniorCpfNoticeShown = true;
    showToast('Salary income generated. Auto-CPF skipped for age 55+ (OA/MA/RA split not automated yet).', 'info');
  }
  return { incomeChanged, cpfChanged: cpf.changed };
}

/* ═══════════════════════════════════════════════════════════════════════
   NAV — tab definitions in display order
   ═══════════════════════════════════════════════════════════════════════ */
const TABS = [
  { key:'dashboard',   label:'Dashboard',   icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>' },
  { key:'stocks',      label:'Stocks',      icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>' },
  { key:'board',       label:'Watchlist+',  icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h18M3 12h18M3 19h18"/><circle cx="7" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="14" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="10" cy="19" r="1.6" fill="currentColor" stroke="none"/></svg>' },
  { key:'cash',        label:'Cash',        icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 10v4M18 10v4"/></svg>' },
  { key:'cpf',         label:'CPF',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l9 4v6c0 5-3.5 9-9 10-5.5-1-9-5-9-10V6z"/><path d="M9 12l2 2 4-4"/></svg>' },
  { key:'cashflow',    label:'P&L',         icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h13l-3-3M21 17H8l3 3"/></svg>' },
  { key:'realestate',  label:'Real Estate', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>' },
  { key:'crypto',      label:'Crypto',      icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9 8h4a2 2 0 1 1 0 4H9zm0 4h4.5a2 2 0 1 1 0 4H9zM10 6v2M10 16v2M13 6v2M13 16v2"/></svg>' },
  { key:'projections', label:'Projections', icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/></svg>' },
  { key:'settings',    label:'Settings',    icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' }
];

/* Phase 2 lock — tabs whose UI and renderers are parked while Phase 1 ships.
   Real markup stays in the DOM (preserved underneath), just hidden by the
   .phase2-locked class. To unblock a tab, remove it from this set. */
const PHASE_2_TABS = new Set(['crypto', 'projections']);

/* Mobile bottom bar shows exactly 5 fixed destinations (Apple's pattern caps
   a tab bar at 5); everything else lives behind the "More" sheet. Decided
   03/07/2026: Dashboard, Stocks, Cash, P&L, More. */
const MOBILE_BOTTOM_TABS = ['dashboard', 'stocks', 'cash', 'cashflow'];

function _phase2LabelFor(key){
  const tab = TABS.find(t => t.key === key);
  return tab ? tab.label : key;
}

function ensurePhase2Card(section, key){
  if (section.querySelector('.phase2-card')) return;
  const label = _phase2LabelFor(key);
  const card = document.createElement('div');
  card.className = 'phase2-card';
  card.innerHTML =
    '<div class="page-head"><div>'
    + '<div class="page-title">' + kjrEscape(label) + ' <span class="phase-chip">Phase 2</span></div>'
    + '<div class="page-sub">Parked while Phase 1 ships.</div>'
    + '</div></div>'
    + '<div class="card"><div class="card-body"><div class="empty">'
    + '<div class="empty-icon">🚧</div>'
    + '<div class="empty-title">Coming in Phase 2</div>'
    + '<div class="empty-sub">Phase 1 focus is Stocks, Real Estate, Cash, CPF, P&amp;L, and Settings. The ' + kjrEscape(label) + ' code is preserved underneath and will return in Phase 2.</div>'
    + '</div></div></div>';
  section.insertBefore(card, section.firstChild);
}

/* ═══════════════════════════════════════════════════════════════════════
   DB — single source of truth, mirrors Kujira's pattern
   ═══════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════
   STOCKS COLUMN REGISTRY — drives the holdings table + the column manager.
   Each column: key, label(dc), defVis (default visible), cls, render(r,ctx).
   Symbol (sticky) and the row actions are fixed and live outside this list.
   `backend:true` marks columns that need the widened Apps Script price fields
   (day range, 52w range, volume); they render — until a redeploy populates them.
   ═══════════════════════════════════════════════════════════════════════ */
const STOCK_COLUMNS = [
  { key:'market', label:()=>'Market', cls:'tl', defVis:true,
    render:r => `<span class="tag ${r.s.market==='SGX'?'sgx':'us'}">${kjrEscape(r.s.market)}</span>` },
  { key:'sector', label:()=>'Sector', cls:'tl', defVis:false,
    render:r => {
      if (!r.s.sector) return '—';
      const cl = sectorClass(r.s.sector);
      const chip = cl ? ` <span class="sec-chip sec-${cl}" title="${cl} sector">${cl==='cyclical'?'Cycl':cl==='defensive'?'Def':'Sens'}</span>` : '';
      return kjrEscape(r.s.sector) + chip;
    } },
  { key:'shares', label:()=>'Shares', cls:'num', defVis:true,
    render:r => r.derived
      ? `${r.shares}<span class="hint" title="Derived from ${r.derived.txnCount} trade${r.derived.txnCount===1?'':'s'}"> ◆</span>`
      : `${r.shares}` },
  { key:'avgCost', label:()=>'Avg cost', cls:'num', defVis:true,
    render:r => fmt(toSGD(r.avgCost, r.ccy)) },
  { key:'price', label:()=>'Price', cls:'num', defVis:true,
    render:r => r.priceSgd!=null
      ? `${fmt(r.priceSgd)}${r.stale?' <span class="hint">(stale)</span>':''}${r.extLine}`
      : '<span class="price-stale">—</span>' },
  { key:'dayChange', label:dc=>`Day P&L (${dc})`, cls:'num', defVis:false,
    render:r => r.changeSgd!=null ? `<span class="${r.changeSgd>=0?'pos':'neg'}">${fmt(r.changeSgd,{signed:true})}</span>` : '—' },
  { key:'dayChangePct', label:()=>'Day %', cls:'num', defVis:false,
    render:r => (r.px&&r.px.changePct!=null) ? `<span class="${r.px.changePct>=0?'pos':'neg'}">${fmtPct(r.px.changePct)}</span>` : '—' },
  { key:'prevClose', label:()=>'Prev close', cls:'num', defVis:false,
    render:r => r.prevCloseSgd!=null ? fmt(r.prevCloseSgd) : '—' },
  { key:'dayRange', label:()=>'Day range', cls:'num', defVis:false, backend:true,
    // priceCcy is only set when px.price != null; fall back to the quote's own
    // currency, then the stock's, so ranges never render unconverted.
    render:r => (r.px&&r.px.dayLow!=null&&r.px.dayHigh!=null)
      ? `${fmt(toSGD(r.px.dayLow,r.priceCcy||r.px.currency||r.ccy))}–${fmt(toSGD(r.px.dayHigh,r.priceCcy||r.px.currency||r.ccy))}` : '—' },
  { key:'week52', label:()=>'52w range', cls:'num', defVis:false, backend:true,
    render:r => (r.px&&r.px.week52Low!=null&&r.px.week52High!=null)
      ? `${fmt(toSGD(r.px.week52Low,r.priceCcy||r.px.currency||r.ccy))}–${fmt(toSGD(r.px.week52High,r.priceCcy||r.px.currency||r.ccy))}` : '—' },
  { key:'pos52w', label:()=>'52w pos', cls:'num', defVis:false, backend:true,
    // Where the price sits in the 52w band: 0% = at the low, 100% = at the high.
    render:r => {
      const v = r.px ? rangePosition(r.px.price, r.px.week52Low, r.px.week52High) : null;
      return v!=null ? `<span title="0% = 52w low, 100% = 52w high">${(v*100).toFixed(0)}%</span>` : '—';
    } },
  { key:'vs200d', label:()=>'vs 200d avg', cls:'num', defVis:false, backend:true,
    render:r => {
      const f = r.px && r.px.fund;
      const v = f ? vsBaseline(r.px.price, f.sma200) : null;
      return v!=null ? `<span class="${v>=0?'pos':'neg'}">${v>=0?'▲':'▼'} ${Math.abs(v*100).toFixed(1)}%</span>` : '—';
    } },
  { key:'vs50d', label:()=>'vs 50d avg', cls:'num', defVis:false, backend:true,
    render:r => {
      const f = r.px && r.px.fund;
      const v = f ? vsBaseline(r.px.price, f.sma50) : null;
      return v!=null ? `<span class="${v>=0?'pos':'neg'}">${v>=0?'▲':'▼'} ${Math.abs(v*100).toFixed(1)}%</span>` : '—';
    } },
  { key:'volume', label:()=>'Volume', cls:'num', defVis:false, backend:true,
    render:r => (r.px&&r.px.volume!=null) ? Number(r.px.volume).toLocaleString('en-SG') : '—' },
  { key:'mv', label:dc=>`Market value (${dc})`, cls:'num', defVis:true,
    render:r => r.mv!=null ? fmt(r.mv, {dp:0}) : '—' },
  { key:'cost', label:dc=>`Cost basis (${dc})`, cls:'num', defVis:false,
    render:r => fmt(r.cost, {dp:0}) },
  { key:'pl', label:dc=>`P&L (${dc})`, cls:'num', defVis:true,
    render:r => r.pl!=null ? `<span class="${r.pl>=0?'pos':'neg'}">${_plArrow(r.pl)}${fmt(r.pl, {dp:0,signed:true})}</span>` : '—' },
  { key:'plPct', label:()=>'P&L %', cls:'num', defVis:true,
    render:r => r.plPct!=null ? `<span class="${r.pl>=0?'pos':'neg'}">${fmtPct(r.plPct)}</span>` : '—' },
  { key:'realised', label:dc=>`Realised P&L (${dc})`, cls:'num', defVis:false,
    render:r => r.realisedSgd!=null ? `<span class="${r.realisedSgd>=0?'pos':'neg'}">${_plArrow(r.realisedSgd)}${fmt(r.realisedSgd, {dp:0,signed:true})}</span>` : '—' },
  { key:'weight', label:()=>'Weight %', cls:'num', defVis:false,
    render:r => r.weight!=null ? r.weight.toFixed(1)+'%' : '—' },
  { key:'divIncome', label:dc=>`Dividend/yr (${dc})`, cls:'num', defVis:false,
    render:r => r.divAnnualSgd!=null ? fmt(r.divAnnualSgd, {dp:0}) : '—' },
  { key:'divYoc', label:()=>'Yield on cost', cls:'num', defVis:false,
    render:r => r.divYoc!=null ? r.divYoc.toFixed(2)+'%' : '—' },
  { key:'divYield', label:()=>'Div yield', cls:'num', defVis:false,
    render:r => r.divYieldCur!=null ? r.divYieldCur.toFixed(2)+'%' : '—' },
  // Fundamentals come from the quoteSummary proxy (px.fund). ETFs and unfetched
  // symbols have no fund object — every cell falls back to the '—' token.
  { key:'peTtm', label:()=>'P/E', cls:'num', defVis:false, backend:true,
    render:r => { const f=r.px&&r.px.fund; return (f&&f.trailingPE!=null) ? f.trailingPE.toFixed(1) : '—'; } },
  { key:'peFwd', label:()=>'Fwd P/E', cls:'num', defVis:false, backend:true,
    render:r => { const f=r.px&&r.px.fund; return (f&&f.forwardPE!=null) ? f.forwardPE.toFixed(1) : '—'; } },
  { key:'pb', label:()=>'P/B', cls:'num', defVis:false, backend:true,
    render:r => { const f=r.px&&r.px.fund; return (f&&f.priceToBook!=null) ? f.priceToBook.toFixed(2) : '—'; } },
  { key:'beta', label:()=>'Beta', cls:'num', defVis:false, backend:true,
    render:r => { const f=r.px&&r.px.fund; return (f&&f.beta!=null) ? f.beta.toFixed(2) : '—'; } },
  { key:'payout', label:()=>'Payout', cls:'num', defVis:false, backend:true,
    render:r => { const f=r.px&&r.px.fund; return (f&&f.payoutRatio!=null) ? (f.payoutRatio*100).toFixed(0)+'%' : '—'; } },
  { key:'mktCap', label:()=>'Mkt cap', cls:'num', defVis:false, backend:true,
    render:r => { const f=r.px&&r.px.fund; return (f&&f.marketCap!=null) ? fmtCompact(toSGD(f.marketCap, f.currency||r.px.currency||r.ccy)) : '—'; } },
  { key:'updated', label:()=>'Updated', cls:'num muted', defVis:true,
    render:r => (r.px&&r.px.fetchedAt) ? relTime(r.px.fetchedAt) : '—' }
];
const STOCK_COL_LABEL = {
  market:'Market', sector:'Sector', shares:'Shares', avgCost:'Avg cost', price:'Price',
  dayChange:'Day P&L (position change)', dayChangePct:'Day change %', prevClose:'Prev close',
  dayRange:'Day range', week52:'52-week range', pos52w:'52-week range position',
  vs200d:'Price vs 200-day average', vs50d:'Price vs 50-day average', volume:'Volume',
  mv:'Market value', cost:'Cost basis', pl:'Unrealised P&L', plPct:'P&L %',
  realised:'Realised P&L', weight:'Portfolio weight %', divIncome:'Dividend income / yr',
  divYoc:'Dividend yield on cost', divYield:'Current dividend yield',
  peTtm:'P/E (trailing)', peFwd:'P/E (forward)', pb:'Price / book', beta:'Beta',
  payout:'Dividend payout %', mktCap:'Market cap', updated:'Updated'
};
/* ═══════════════════════════════════════════════════════════════════════
   WATCHLIST+ BOARD COLUMNS — a Yahoo-style customisable view over the same
   watchlist tickers. Cells read the watchlist row (w + px quote + px.fund).
   `backend:true` marks columns that need the widened Apps Script price fields.
   ═══════════════════════════════════════════════════════════════════════ */
const BOARD_COLUMNS = [
  { key:'companyName', label:()=>'Name', cls:'tl', defVis:false,
    render:r => (r.px && r.px.shortName) ? kjrEscape(r.px.shortName) : '—' },
  { key:'market', label:()=>'Market', cls:'tl', defVis:true,
    render:r => `<span class="tag ${r.w.market==='SGX'?'sgx':'us'}">${kjrEscape(r.w.market||'')}</span>` },
  { key:'sector', label:()=>'Sector', cls:'tl', defVis:true,
    render:r => {
      if (!r.w.sector) return '—';
      const cl = sectorClass(r.w.sector);
      const chip = cl ? ` <span class="sec-chip sec-${cl}" title="${cl} sector">${cl==='cyclical'?'Cycl':cl==='defensive'?'Def':'Sens'}</span>` : '';
      return kjrEscape(r.w.sector) + chip;
    } },
  { key:'price', label:()=>'Price', cls:'num', defVis:true,
    render:r => (r.px && r.px.price!=null)
      ? fmt(toSGD(r.px.price, r.ccy)) + (isStale(r.px.fetchedAt,24)?' <span class="hint">(stale)</span>':'')
      : '<span class="price-stale">—</span>' },
  { key:'change', label:()=>'Change', cls:'num', defVis:true,
    render:r => (r.px && r.px.change!=null)
      ? `<span class="${r.px.change>=0?'pos':'neg'}">${fmt(toSGD(r.px.change, r.ccy),{signed:true})}</span>` : '—' },
  { key:'changePct', label:()=>'Change %', cls:'num', defVis:true,
    render:r => (r.px && r.px.changePct!=null)
      ? `<span class="${r.px.changePct>=0?'pos':'neg'}">${fmtPct(r.px.changePct)}</span>` : '—' },
  { key:'prevClose', label:()=>'Prev close', cls:'num', defVis:false,
    render:r => (r.px && r.px.previousClose!=null) ? fmt(toSGD(r.px.previousClose, r.ccy)) : '—' },
  { key:'dayRange', label:()=>'Day range', cls:'num', defVis:true, backend:true,
    render:r => (r.px && r.px.dayLow!=null && r.px.dayHigh!=null)
      ? `${fmt(toSGD(r.px.dayLow, r.ccy))}–${fmt(toSGD(r.px.dayHigh, r.ccy))}` : '—' },
  { key:'week52', label:()=>'52w range', cls:'num', defVis:true, backend:true,
    render:r => (r.px && r.px.week52Low!=null && r.px.week52High!=null)
      ? `${fmt(toSGD(r.px.week52Low, r.ccy))}–${fmt(toSGD(r.px.week52High, r.ccy))}` : '—' },
  { key:'pos52w', label:()=>'52w pos', cls:'num', defVis:false, backend:true,
    render:r => { const v = r.px ? rangePosition(r.px.price, r.px.week52Low, r.px.week52High) : null;
      return v!=null ? `<span title="0% = 52w low, 100% = 52w high">${(v*100).toFixed(0)}%</span>` : '—'; } },
  { key:'volume', label:()=>'Volume', cls:'num', defVis:true, backend:true,
    render:r => (r.px && r.px.volume!=null) ? Number(r.px.volume).toLocaleString('en-SG') : '—' },
  { key:'mktCap', label:()=>'Mkt cap', cls:'num', defVis:true, backend:true,
    render:r => { const f=r.px&&r.px.fund; return (f&&f.marketCap!=null) ? fmtCompact(toSGD(f.marketCap, f.currency||r.px.currency||r.ccy)) : '—'; } },
  { key:'peTtm', label:()=>'P/E', cls:'num', defVis:false, backend:true,
    render:r => { const f=r.px&&r.px.fund; return (f&&f.trailingPE!=null) ? f.trailingPE.toFixed(1) : '—'; } },
  { key:'peFwd', label:()=>'Fwd P/E', cls:'num', defVis:false, backend:true,
    render:r => { const f=r.px&&r.px.fund; return (f&&f.forwardPE!=null) ? f.forwardPE.toFixed(1) : '—'; } },
  { key:'pb', label:()=>'P/B', cls:'num', defVis:false, backend:true,
    render:r => { const f=r.px&&r.px.fund; return (f&&f.priceToBook!=null) ? f.priceToBook.toFixed(2) : '—'; } },
  { key:'beta', label:()=>'Beta', cls:'num', defVis:false, backend:true,
    render:r => { const f=r.px&&r.px.fund; return (f&&f.beta!=null) ? f.beta.toFixed(2) : '—'; } },
  { key:'payout', label:()=>'Payout', cls:'num', defVis:false, backend:true,
    render:r => { const f=r.px&&r.px.fund; return (f&&f.payoutRatio!=null) ? (f.payoutRatio*100).toFixed(0)+'%' : '—'; } },
  { key:'exchange', label:()=>'Exchange', cls:'tl', defVis:false,
    render:r => (r.px && r.px.exchange) ? kjrEscape(r.px.exchange) : '—' },
  { key:'target', label:()=>'Target', cls:'num', defVis:true,
    render:r => {
      if (r.w.targetPrice == null) return '—';
      const atTarget = (r.px && r.px.price!=null && r.px.price <= Number(r.w.targetPrice));
      return fmt(toSGD(Number(r.w.targetPrice), r.ccy)) + (atTarget ? ' <span class="wl-hit">✓ At target</span>' : '');
    } },
  { key:'notes', label:()=>'Notes', cls:'tl', defVis:true,
    render:r => r.w.notes ? `<span class="wl-note" title="${kjrEscape(r.w.notes)}">${kjrEscape(r.w.notes)}</span>` : '' },
  { key:'updated', label:()=>'Updated', cls:'num muted', defVis:true,
    render:r => (r.px && r.px.fetchedAt) ? relTime(r.px.fetchedAt) : '—' }
];
const BOARD_COL_LABEL = {
  companyName:'Company name', market:'Market', sector:'Sector', price:'Price', change:'Day change',
  changePct:'Day change %', prevClose:'Prev close', dayRange:'Day range', week52:'52-week range',
  pos52w:'52-week range position', volume:'Volume', mktCap:'Market cap', peTtm:'P/E (trailing)',
  peFwd:'P/E (forward)', pb:'Price / book', beta:'Beta', payout:'Dividend payout %',
  exchange:'Exchange', target:'Target price', notes:'Notes', updated:'Updated'
};

/* ── Generic column manager ──────────────────────────────────────────────
   One tested code path drives both the Holdings table and the Watchlist+
   board. Each surface is a descriptor in COLSETS. Holdings keeps its old
   function names as thin wrappers so renderStocks/mergeDefaults stay intact. */
const COLSETS = {
  stocks: { reg: STOCK_COLUMNS, labels: STOCK_COL_LABEL, key:'stocksColumns',
            body:'stock-cols-body', modal:'stock-cols-modal', rerender:()=>renderStocks() },
  board:  { reg: BOARD_COLUMNS, labels: BOARD_COL_LABEL, key:'boardColumns',
            body:'board-cols-body', modal:'board-cols-modal', rerender:()=>renderBoard() }
};
function defaultCols(reg){ return reg.map(c => ({ key:c.key, visible: !!c.defVis })); }
/* Reconcile a stored column preference against the current registry: keep known
   keys in their saved order + visibility, append any new columns at their default,
   drop unknown keys. Mirrors how mergeDefaults de-risks schema evolution. */
function reconcileCols(stored, reg){
  const valid = new Set(reg.map(c => c.key));
  const out = [], seen = new Set();
  if (Array.isArray(stored)) stored.forEach(e => {
    if (e && valid.has(e.key) && !seen.has(e.key)){ out.push({ key:e.key, visible: e.visible !== false }); seen.add(e.key); }
  });
  reg.forEach(c => { if (!seen.has(c.key)){ out.push({ key:c.key, visible: !!c.defVis }); seen.add(c.key); } });
  return out;
}
/* Registry defs in the user's saved order, each carrying its current visibility. */
function orderedCols(setKey){
  const cs = COLSETS[setKey];
  const pref = reconcileCols(DB.settings && DB.settings[cs.key], cs.reg);
  const byKey = {}; cs.reg.forEach(c => byKey[c.key] = c);
  return pref.map(p => Object.assign({}, byKey[p.key], { visible: p.visible })).filter(c => c.key);
}
/* Holdings wrappers — preserve existing call sites (renderStocks, mergeDefaults, freshDB). */
function defaultStockColumns(){ return defaultCols(STOCK_COLUMNS); }
function reconcileStockColumns(stored){ return reconcileCols(stored, STOCK_COLUMNS); }
function orderedStockCols(){ return orderedCols('stocks'); }

/* Sort accessors, kept separate so the registry stays presentation-only.
   Each returns a raw comparable (number, string, or null). Money values
   compare in SGD so mixed-currency columns sort correctly. Null = no data,
   always sorts last regardless of direction. */
const STOCK_SORT_VALS = {
  symbol:       r => r.s.symbol || '',
  market:       r => r.s.market || '',
  shares:       r => r.shares,
  avgCost:      r => toSGD(r.avgCost, r.ccy),
  price:        r => r.priceSgd,
  dayChange:    r => r.changeSgd,
  dayChangePct: r => (r.px && r.px.changePct != null) ? r.px.changePct : null,
  prevClose:    r => r.prevCloseSgd,
  dayRange:     r => (r.px && r.px.dayHigh != null) ? toSGD(r.px.dayHigh, r.priceCcy || r.px.currency || r.ccy) : null,
  week52:       r => (r.px && r.px.week52High != null) ? toSGD(r.px.week52High, r.priceCcy || r.px.currency || r.ccy) : null,
  volume:       r => (r.px && r.px.volume != null) ? r.px.volume : null,
  mv:           r => r.mv,
  cost:         r => r.cost,
  pl:           r => r.pl,
  plPct:        r => r.plPct,
  realised:     r => r.realisedSgd,
  weight:       r => r.weight,
  divIncome:    r => r.divAnnualSgd,
  divYoc:       r => r.divYoc,
  divYield:     r => r.divYieldCur,
  // Sector groups by cyclical/defensive/sensitive bucket first, then name,
  // so an asc sort clusters the classes together. Untagged sorts last (null).
  sector:       r => r.s.sector ? ((sectorClass(r.s.sector) || 'z') + '·' + r.s.sector) : null,
  pos52w:       r => r.px ? rangePosition(r.px.price, r.px.week52Low, r.px.week52High) : null,
  vs200d:       r => (r.px && r.px.fund) ? vsBaseline(r.px.price, r.px.fund.sma200) : null,
  vs50d:        r => (r.px && r.px.fund) ? vsBaseline(r.px.price, r.px.fund.sma50)  : null,
  peTtm:        r => (r.px && r.px.fund && r.px.fund.trailingPE  != null) ? r.px.fund.trailingPE  : null,
  peFwd:        r => (r.px && r.px.fund && r.px.fund.forwardPE   != null) ? r.px.fund.forwardPE   : null,
  pb:           r => (r.px && r.px.fund && r.px.fund.priceToBook != null) ? r.px.fund.priceToBook : null,
  beta:         r => (r.px && r.px.fund && r.px.fund.beta        != null) ? r.px.fund.beta        : null,
  payout:       r => (r.px && r.px.fund && r.px.fund.payoutRatio != null) ? r.px.fund.payoutRatio : null,
  mktCap:       r => (r.px && r.px.fund && r.px.fund.marketCap   != null)
                       ? toSGD(r.px.fund.marketCap, r.px.fund.currency || r.px.currency || r.ccy) : null,
  updated:      r => (r.px && r.px.fetchedAt) || null
};
/* Header click cycle: asc → desc → clear. Unknown keys are ignored. */
function setStockSort(key){
  if (!STOCK_SORT_VALS[key]) return;
  const cur = DB.settings.stocksSort || {};
  DB.settings.stocksSort = cur.key !== key ? { key, dir:'asc' }
    : cur.dir === 'asc' ? { key, dir:'desc' }
    : { key:null, dir:null };
  _stocksPage = 0; saveData(); renderStocks();
}
function setWatchlistSort(key){
  const cur = DB.settings.watchlistSort || {};
  DB.settings.watchlistSort = cur.key !== key ? { key, dir:'asc' }
    : cur.dir === 'asc' ? { key, dir:'desc' }
    : { key:null, dir:null };
  saveData(); renderWatchlist();
}

function freshDB(){
  return {
    stocks:       [],
    stockTxns:    [],
    watchlist:    [],
    crypto:       [],
    realestate:   [],
    cash:         [],
    cashTxns:     [],
    cpfBalances:  { OA:0, SA:0, MA:0, RA:0, updatedAt:null, anchorDate:null },
    cpfHistory:   [],
    income:       [],
    expenses:     [],
    snapshots:    [],
    categories:   {
      income:  ['Salary', 'Bonus', 'Dividends', 'Rental', 'Side income', 'Refund', 'Other'],
      expense: ['Housing', 'Food', 'Transport', 'Utilities', 'Insurance', 'Healthcare', 'Entertainment', 'Shopping', 'Travel', 'Education', 'Personal', 'Tax', 'Other']
    },
    settings:     {
      baseCurrency: 'SGD',
      tabCurrency:  {},   // per-tab display overrides; defaults: stocks=USD, rest=SGD
      stocksColumns: defaultStockColumns(),  // holdings table columns: order + visibility
      stocksSort:    { key:null, dir:null },  // holdings table sort: column + asc|desc
      watchlistSort: { key:null, dir:null },  // watchlist sort: column + asc|desc
      boardColumns:  defaultCols(BOARD_COLUMNS), // Watchlist+ board: column order + visibility
      boardSort:     { key:null, dir:null },  // Watchlist+ board sort: column + asc|desc
      fxRates:      { USDSGD: null, lastUpdated: null },
      fxOverrides:  { USDSGD: null },
      birthYear:    null,
      retirementAge: 65,
      expectedReturn: 6.0,
      inflationRate:  3.0,
      fireMultiple:   25,
      fireTarget:     null,
      cpfRates:       Object.assign({}, CPF_DEFAULTS),
      salary:         {
        employer:     '',
        grossMonthly: null,   // SGD, gross before CPF
        startDate:    null,   // 'YYYY-MM-DD'
        endDate:      null,   // 'YYYY-MM-DD' or null = ongoing
        annualBonus:  null,   // SGD lump (config only for now)
        bonusMonth:   null    // 1-12 (config only for now)
      },
      // Target asset allocation (% of net worth) + rebalancing tolerance.
      targets:        { stocks:0, cash:0, cpf:0, realestate:0, crypto:0 },
      rebalanceThreshold: 5,  // flag a class when it drifts > this many points off target
      // Emergency fund: how many SGD of cash you want parked as a safety net.
      efTarget:       null,
      // Salary allocation rules: how each payday's take-home is earmarked.
      // Each: { id, name, pct, dest }. Should sum to 100%.
      salaryRules:    [],
      // Salary auto-deposit: each payday, deposit `salarySavePct`% of take-home
      // into `salaryAccountId` and log the rest as a Discretionary expense.
      // `salaryCashEnabledAt` is stamped when the account is first set so the
      // deposits start from the next payday and never backfill the opening balance.
      salaryAccountId:     '',
      salarySavePct:       50,
      salaryCashEnabledAt: '',
      salaryDiscretionaryAccountId: '',   // optional spending account (e.g. UOB)
      // SG income tax estimate. Annual figure; monthly = annual / 12 (accrual, not PAYE).
      tax: {
        residency:       'resident',  // 'resident' | 'non-resident'
        totalReliefs:    1000,        // SGD. Default = earned income relief ($1,000).
        manualAnnualTax: null         // Override. Null = use computed estimate.
      },
      // Dashboard chart builder + saved charts + arrange order. Device-local
      // until D1; now DB-resident so they ride sync, export and import.
      // savedCharts: null = never seeded yet (seed the 3 defaults once on
      // next render); [] = user deliberately deleted every chart (never
      // re-seed); array = the charts themselves. Null and [] must stay
      // distinct so "delete everything" cannot look like "brand new".
      savedCharts:  null,
      chartBuilder: null,   // live chart-builder config, or null = use the built-in default
      dashLayout:   []      // dashboard card arrange order (widget ids)
    },
    _priceCache:  {},
    changelog:    [],
    _meta:        { createdAt: new Date().toISOString(), appVersion: APP_VERSION }
  };
}

let DB = freshDB();

/* ═══════════════════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════════════════ */
function uid(prefix){ return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8); }

function kjrEscape(s){
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ─── Sanitisation: defence-in-depth at every boundary ──────────────────
   ids: alnum + underscore + hyphen, 1-64 chars. Anything else is rejected.
   strings: trimmed, control chars stripped, length capped (default 500).
   numbers: coerced to finite float; non-finite returns null.
   These run in three places: on every form save (entityModalSave), on
   every read from the cloud (mergeDefaults), and before any data is
   interpolated into a JS context. Keeps a corrupted sheet from breaking
   the app, and stops an attacker who somehow writes to the sheet from
   landing an XSS via crafted ids or notes. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function kjrSafeId(s){
  if (s == null) return null;
  const v = String(s);
  return SAFE_ID_RE.test(v) ? v : null;
}
function kjrSafeString(s, maxLen){
  if (s == null) return '';
  const cap = maxLen || 500;
  let v = String(s);
  // Strip ASCII control chars (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F).
  // Preserve tab/newline/CR so multi-line notes survive.
  v = v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (v.length > cap) v = v.slice(0, cap);
  return v;
}


/* Money formatter and the single currency-conversion point for the app.
   Values are stored and computed in SGD; fmt converts to the active display
   currency (the SGD/USD toggle) and labels accordingly. Pass opts.noConvert
   for a figure that is already in the display currency, or opts.currency to
   force a specific label without conversion. */
function fmt(n, opts){
  opts = opts || {};
  let v = Number(n);
  if (!isFinite(v)) return '—';
  let cur;
  if (opts.currency){
    cur = opts.currency;            // explicit label, value already in that ccy
  } else if (opts.noConvert){
    cur = displayCcy();
  } else {
    v = toDisplay(v, 'SGD');        // SGD figure → active display currency
    cur = displayCcy();
  }
  try {
    const s = new Intl.NumberFormat('en-SG', {
      style: 'currency', currency: cur,
      minimumFractionDigits: opts.dp != null ? opts.dp : 2,
      maximumFractionDigits: opts.dp != null ? opts.dp : 2
    }).format(v);
    // opts.signed: prepend + on positive deltas so direction never relies on colour
    // alone (negatives already carry a minus). Used by change / P&L / realised cells.
    return (opts.signed && v > 0) ? '+' + s : s;
  } catch(_){ return (cur + ' ' + v.toFixed(2)); }
}

function fmtPct(n, dp){
  const v = Number(n);
  if (!isFinite(v)) return '—';
  // Trend arrow + sign so percentage direction is legible without colour (a11y).
  const arrow = v > 0 ? '▲ ' : v < 0 ? '▼ ' : '';
  return arrow + (v >= 0 ? '+' : '') + v.toFixed(dp != null ? dp : 2) + '%';
}

/* Same arrow-plus-sign-plus-colour rule as fmtPct, for the money-value P&L
   cells (fmt() with signed:true already adds the +, this just prepends the
   matching trend arrow so a colour-blind reader gets the same signal). */
function _plArrow(v){
  const n = Number(v);
  if (!isFinite(n)) return '';
  return n > 0 ? '▲ ' : n < 0 ? '▼ ' : '';
}

/* Compact money for huge figures (market cap): $3.21T, US$310.45B, $48.0M.
   Takes an SGD figure and follows the display-currency toggle like fmt(). */
function fmtCompact(n){
  let v = Number(n);
  if (!isFinite(v) || v <= 0) return '—';
  v = toDisplay(v, 'SGD');
  const cur = displayCcy() === 'USD' ? 'US$' : '$';
  if (v >= 1e12) return cur + (v/1e12).toFixed(2) + 'T';
  if (v >= 1e9)  return cur + (v/1e9).toFixed(2) + 'B';
  if (v >= 1e6)  return cur + (v/1e6).toFixed(1) + 'M';
  return cur + Math.round(v).toLocaleString('en-SG');
}

function fmtDateSG(d){
  // DD/MM/YYYY per Singapore convention
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  const dd = String(dt.getDate()).padStart(2,'0');
  const mm = String(dt.getMonth()+1).padStart(2,'0');
  return dd + '/' + mm + '/' + dt.getFullYear();
}

function relTime(d){
  if (!d) return 'never';
  const t = (d instanceof Date) ? d : new Date(d);
  if (isNaN(t.getTime())) return 'never';
  const s = Math.round((Date.now() - t.getTime()) / 1000);
  if (s < 5)   return 'just now';
  if (s < 60)  return s + 's ago';
  if (s < 3600) return Math.round(s/60) + 'm ago';
  if (s < 86400) return Math.round(s/3600) + 'h ago';
  return Math.round(s/86400) + 'd ago';
}

function showToast(msg, kind, action){
  const host = document.getElementById('toast-host');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  // Optional inline action (e.g. Undo). Built from nodes, never innerHTML, so
  // the message stays text-safe. An action toast lingers longer (8s) so the
  // affordance is actually reachable.
  if (action && action.label && typeof action.fn === 'function'){
    const span = document.createElement('span'); span.textContent = msg;
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = action.label;
    btn.style.cssText = 'margin-left:12px;background:none;border:none;color:inherit;font:inherit;font-weight:700;text-decoration:underline;cursor:pointer;padding:0';
    btn.onclick = () => { try{ action.fn(); } finally { el.remove(); } };
    el.append(span, btn);
  } else {
    el.textContent = msg;
  }
  host.appendChild(el);
  const ttl = (action || kind === 'error') ? 8000 : 5000;
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; }, ttl);
  setTimeout(() => el.remove(), ttl + 400);
}

/* ═══════════════════════════════════════════════════════════════════════
   PERSISTENCE — local storage immediate, cloud debounced
   ═══════════════════════════════════════════════════════════════════════ */
/* Build the object we persist locally. The price cache is a transient,
   re-fetchable mirror of Yahoo/CoinGecko quotes — there is no reason to spend
   the (~5MB) localStorage budget on it, and pre/post-market quotes can bloat it
   enough to blow the quota and block saving your actual financial data. So we
   never write it to disk; it lives in memory only and repopulates on refresh. */
function localPersistPayload(){
  const { _priceCache, ...rest } = DB;
  return rest;
}

/* Resilient local save. If the quota is exceeded we shed disposable data in
   order (changelog tail, then snapshot history) and retry, so a full disk can
   never silently drop your holdings, cash, CPF, or trades. */
function saveLocal(){
  const attempts = [
    () => JSON.stringify(localPersistPayload()),
    () => { // drop changelog (rebuildable audit trail)
      const p = localPersistPayload(); p.changelog = [];
      return JSON.stringify(p);
    },
    () => { // also thin snapshots to the most recent 180 days
      const p = localPersistPayload(); p.changelog = [];
      if (Array.isArray(p.snapshots) && p.snapshots.length > 180) p.snapshots = p.snapshots.slice(-180);
      return JSON.stringify(p);
    }
  ];
  for (let i = 0; i < attempts.length; i++){
    try {
      localStorage.setItem(LK_DB, attempts[i]());
      if (i > 0) showToast('Saved. Trimmed old history to fit local storage.', 'success');
      // Persist price cache separately so the first paint on reload uses last-known prices
      try { localStorage.setItem(LK_PRICE_CACHE, JSON.stringify(DB._priceCache || {})); } catch (_) {}
      return true;
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || '')) && i < attempts.length - 1) {
        continue; // try a leaner payload
      }
      console.error('localStorage write failed', e);
      showToast('Local save failed: ' + (e && e.message ? e.message : e) + '. Your data is still in memory, set up cloud sync in Settings to protect it.', 'error');
      return false;
    }
  }
  return false;
}

function loadLocal(){
  try {
    const raw = localStorage.getItem(LK_DB);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    DB = mergeDefaults(obj);
    // Restore last-known prices so first paint shows market value, not cost basis
    try {
      const pc = localStorage.getItem(LK_PRICE_CACHE);
      if (pc) DB._priceCache = Object.assign({}, JSON.parse(pc), DB._priceCache);
    } catch (_) {}
    return true;
  } catch (e) {
    console.error('localStorage read failed', e);
    return false;
  }
}

/* Forward-only schema migrations. Add entries here when a breaking field rename
   or removal ships — key is the version being migrated TO.
   Example (not active): _MIGRATIONS[2] = db => { db.newField = db.oldField; delete db.oldField; return db; }
   Currently at v1 — no migrations needed yet; the infrastructure is the deliverable. */
const _MIGRATIONS = {
  /* v2: one-time reset of display-currency preferences. The per-tab header
     toggle persisted a USD override on whichever tab it was tapped on, so
     non-stock tabs stuck on USD. Clear the overrides and pin the base to SGD
     so the scheme is: SGD everywhere, USD only on Stocks. The toggle still
     works afterwards — this just resets the accumulated overrides once. */
  2: db => {
    const settings = Object.assign({}, db.settings);
    settings.tabCurrency = {};
    settings.baseCurrency = 'SGD';
    return Object.assign({}, db, { settings });
  },
  /* v3: CPF history amounts are now uniformly signed (withdrawals negative,
     contributions/interest positive). Older rows may hold a positive
     "withdrawal" amount from before entityModalSave started normalising the
     sign, flip those once. Already-negative or non-withdrawal rows pass
     through unchanged (-Math.abs is idempotent). */
  3: db => {
    if (!Array.isArray(db.cpfHistory)) return db;
    const cpfHistory = db.cpfHistory.map(h => {
      if (h && h.type === 'withdrawal' && h.amount != null){
        const amt = Number(h.amount);
        if (isFinite(amt)) return Object.assign({}, h, { amount: -Math.abs(amt) });
      }
      return h;
    });
    return Object.assign({}, db, { cpfHistory });
  }
};

function _runMigrations(db){
  const v = Number(db.schemaVersion) || 0;
  if (v >= SCHEMA_VERSION) return db;
  let out = Object.assign({}, db);
  for (let from = v; from < SCHEMA_VERSION; from++){
    const fn = _MIGRATIONS[from + 1];
    if (fn) out = fn(out);
  }
  return out;
}

/* Defensive merge so old payloads pick up new top-level keys when we ship features.
   Also re-validates ids on every list-typed table — a corrupted sheet or hostile
   payload cannot land an id like "x'); evil(); //" that would break event-delegation
   downstream. Items with invalid ids get a fresh uid() so they're still recoverable. */
const _LIST_TABLES = ['stocks','stockTxns','watchlist','crypto','realestate','cash','cashTxns','cpfHistory','income','expenses','snapshots','changelog','trash'];

/* Date-typed fields per list table (per ENTITY_SCHEMAS), used to sanitise
   calendar-invalid dates (e.g. 2026-02-30) coming from the cloud or an
   import. The row is kept, only the bad date is nulled, so a corrupted
   sheet or a hostile payload cannot silently misrepresent a date as valid
   downstream (fmtDateSG, sorting, salary/CPF engines). */
const _DATE_FIELDS_BY_TABLE = {
  stocks: ['divExDate', 'divPayDate'],
  stockTxns: ['date'],
  cash: ['asOf'],
  cashTxns: ['date'],
  cpfHistory: ['date'],
  income: ['date'],
  expenses: ['date']
};
let _sanitiseInvalidDateCount = 0;   // recovered-date counter, reset per mergeDefaults() run

function _sanitiseList(arr, table){
  if (!Array.isArray(arr)) return [];
  const dateFields = _DATE_FIELDS_BY_TABLE[table];
  return arr.map(item => {
    if (!item || typeof item !== 'object') return null;
    const safe = Object.assign({}, item);
    if (!kjrSafeId(safe.id)) safe.id = uid(table);
    if (dateFields){
      dateFields.forEach(k => {
        if (safe[k] && !kjrValidDate(safe[k])){ safe[k] = null; _sanitiseInvalidDateCount++; }
      });
    }
    return safe;
  }).filter(Boolean);
}

function mergeDefaults(loaded){
  const base = freshDB();
  const safe = (loaded && typeof loaded === 'object') ? _runMigrations(loaded) : {};
  const out  = Object.assign({}, base, safe);
  out.settings   = Object.assign({}, base.settings, safe.settings || {});
  out.settings.cpfRates    = Object.assign({}, base.settings.cpfRates,    (safe.settings && safe.settings.cpfRates) || {});
  out.settings.fxRates     = Object.assign({}, base.settings.fxRates,     (safe.settings && safe.settings.fxRates)  || {});
  out.settings.fxOverrides = Object.assign({}, base.settings.fxOverrides, (safe.settings && safe.settings.fxOverrides) || {});
  out.settings.salary      = Object.assign({}, base.settings.salary,      (safe.settings && safe.settings.salary)      || {});
  out.settings.tabCurrency = Object.assign({}, base.settings.tabCurrency, (safe.settings && safe.settings.tabCurrency) || {});
  out.settings.stocksColumns = reconcileStockColumns(safe.settings && safe.settings.stocksColumns);
  const _ss = (safe.settings && safe.settings.stocksSort) || {};
  out.settings.stocksSort = {
    key: typeof _ss.key === 'string' ? _ss.key : null,
    dir: (_ss.dir === 'asc' || _ss.dir === 'desc') ? _ss.dir : null
  };
  out.settings.boardColumns = reconcileCols(safe.settings && safe.settings.boardColumns, BOARD_COLUMNS);
  const _bs = (safe.settings && safe.settings.boardSort) || {};
  out.settings.boardSort = {
    key: typeof _bs.key === 'string' ? _bs.key : null,
    dir: (_bs.dir === 'asc' || _bs.dir === 'desc') ? _bs.dir : null
  };
  out.settings.targets     = Object.assign({}, base.settings.targets,     (safe.settings && safe.settings.targets)     || {});
  // salaryRules is an array; keep loaded value if it is one, else default.
  out.settings.salaryRules = Array.isArray(safe.settings && safe.settings.salaryRules)
    ? safe.settings.salaryRules : base.settings.salaryRules.slice();
  out.settings.tax = Object.assign({}, base.settings.tax, (safe.settings && safe.settings.tax) || {});
  // D1: saved charts / chart-builder state / dash layout, now DB-resident.
  // savedCharts and chartBuilder: null is meaningful (see freshDB comment),
  // so only coerce a non-null, non-array/non-object stray value back to null.
  // dashLayout must be an array; anything else falls back to the default.
  const _sc = safe.settings && safe.settings.savedCharts;
  out.settings.savedCharts = (_sc === null || Array.isArray(_sc)) ? _sc : (out.settings.savedCharts ?? null);
  const _cb = safe.settings && safe.settings.chartBuilder;
  out.settings.chartBuilder = (_cb === null || (_cb && typeof _cb === 'object')) ? _cb : (out.settings.chartBuilder ?? null);
  out.settings.dashLayout = Array.isArray(safe.settings && safe.settings.dashLayout)
    ? safe.settings.dashLayout : base.settings.dashLayout.slice();
  out.categories = Object.assign({}, base.categories, safe.categories || {});
  out.cpfBalances = Object.assign({}, base.cpfBalances, safe.cpfBalances || {});
  // Migration: pre-anchor data has updatedAt but no anchorDate. Treat the last
  // save as the anchor so the typed figure stays put and only grows forward.
  if (!out.cpfBalances.anchorDate && out.cpfBalances.updatedAt) out.cpfBalances.anchorDate = String(out.cpfBalances.updatedAt).slice(0,10);
  _sanitiseInvalidDateCount = 0;
  _LIST_TABLES.forEach(t => { out[t] = _sanitiseList(out[t], t); });
  if (_sanitiseInvalidDateCount > 0) console.warn('mergeDefaults: nulled ' + _sanitiseInvalidDateCount + ' calendar-invalid date field(s) from loaded data');
  if (!out._priceCache || typeof out._priceCache !== 'object') out._priceCache = {};
  out.schemaVersion = SCHEMA_VERSION;
  return out;
}

/* Single entry point for "I changed something, persist + sync".
   Mirrors Kujira's saveData() debounce pattern. */
let _syncTimer = null;
function saveData(){
  saveLocal();
  if (_syncTimer) clearTimeout(_syncTimer);
  if (!getSyncUrl()) { setSyncStatus('local'); return; }
  _syncTimer = setTimeout(pushToRemote, SYNC_DEBOUNCE_MS);
  setSyncStatus('syncing'); // visual feedback before debounce fires
}

/* ═══════════════════════════════════════════════════════════════════════
   SYNC — Apps Script JSON blob, optimistic concurrency
   Pattern lifted from Send Ops, schema identifier swapped.
   ═══════════════════════════════════════════════════════════════════════ */
function getSyncUrl(){ return (localStorage.getItem(LK_SYNC_URL) || '').trim(); }

/* AGENTS.md data-safety rule 1: never let a preview origin push to the cloud.
   Origin isolation (localhost never shares a sync URL with the live site)
   was the only thing stopping this. If a real sync URL is ever pasted into
   a localhost/file: session (e.g. copy-pasted for debugging), this is the
   last line of defence against seeded QA data overwriting a real sheet. */
function isLocalPreview(){
  const h = location.hostname;
  return location.protocol === 'file:' || h === 'localhost' || h === '127.0.0.1';
}
function setSyncUrl(u){
  if (u) localStorage.setItem(LK_SYNC_URL, u.trim());
  else   localStorage.removeItem(LK_SYNC_URL);
  updateSyncStatusPill();
}

/* _priceCache is stripped, same as localPersistPayload: it is refetchable and
   large (quotes + fundamentals per symbol), and syncing it eats the 49.5KB
   sheet-cell payload cap for no reason. */
function syncPayload(){
  const { _priceCache, ...rest } = DB;
  return Object.assign({}, rest, {
    schema: SCHEMA,
    version: 1,
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    updatedAt: new Date().toISOString(),
    lastSeenRemoteAt: localStorage.getItem(LK_LAST_PULL) || null
  });
}

let _bloatWarned = false;
let _activeSyncController = null;

/* Tracks whether the stored LK_LAST_PULL came from the server (data._savedAt
   on pull, or data.savedAt on push) or from the client's own updatedAt
   (which is the case when the user is running an outdated backend). When
   the source is 'client', the next push is guaranteed to conflict because
   client timestamps never match server's C1. We auto-resolve in that case
   with a force-push instead of nagging the user.
   Persisted to localStorage so it survives reloads — without persistence
   the flag resets to its default on every page open and we wrongly assume
   the stamp is from the client. */
function lastPullSource(){ return localStorage.getItem(LK_LAST_PULL_SRC) || 'client'; }
function setLastPull(stamp, source){
  if (stamp != null) localStorage.setItem(LK_LAST_PULL, stamp);
  localStorage.setItem(LK_LAST_PULL_SRC, source === 'server' ? 'server' : 'client');
}

/* In single-user BYOB mode, every "conflict" is benign — there's no second
   user to actually diverge from. The mismatch is clock drift, Sheets
   cell-format round-trip, or a race between an auto-refresh tick and a
   user edit. We auto-recover every time, with one retry on transient
   network errors (Apps Script's redirect chain to googleusercontent.com
   occasionally returns 404+HTML, especially from file:// origins).
   The legacy modal is hidden behind an opt-in setting for power users who
   actually sync from multiple devices. */
let _conflictResolvingNow = false;  // prevents recursive recovery loops
let _resyncToastShown = false;      // toast suggestion shown once per session

/* Safely parse a fetch response as JSON. Returns { ok, data, status, text }.
   Apps Script's redirect chain can return HTML (404, login pages, error
   pages) — we surface that as ok:false instead of throwing. */
async function safeJson(resp){
  const status = resp.status;
  const text = await resp.text();
  try {
    return { ok: true, status, data: JSON.parse(text), text };
  } catch (_) {
    return { ok: false, status, data: null, text };
  }
}

/* Tables compared when deciding whether a sync conflict is genuine divergence
   (two devices with different edits) or just clock/timestamp drift on an
   otherwise identical blob. Deliberately excludes volatile fields that always
   differ between two independent reads of the "same" data: updatedAt,
   lastSeenRemoteAt, _savedAt, _priceCache (never synced), _meta, appVersion,
   schemaVersion, version. */
const _DIVERGENCE_TABLES = ['stocks','stockTxns','watchlist','crypto','realestate','cash','cashTxns',
  'cpfBalances','cpfHistory','income','expenses','snapshots','categories','settings','changelog','trash'];
function _divergenceSnapshot(obj){
  const src = obj || {};
  const out = {};
  _DIVERGENCE_TABLES.forEach(k => { out[k] = src[k] !== undefined ? src[k] : null; });
  return JSON.stringify(out);
}
function _isMaterialDivergence(localObj, remoteObj){
  return _divergenceSnapshot(localObj) !== _divergenceSnapshot(remoteObj);
}

function strictConflictsEnabled(){
  return localStorage.getItem('kjr-pf-strict-conflicts-v1') === '1';
}

function setStrictConflicts(on){
  localStorage.setItem('kjr-pf-strict-conflicts-v1', on ? '1' : '0');
  showToast(on ? 'Strict conflict modal enabled' : 'Silent auto-recovery enabled', 'success');
}

async function pushToRemote(){
  const url = getSyncUrl();
  if (!url) { setSyncStatus('local'); return; }
  // Preview guard (AGENTS.md data-safety rule 1): never let a localhost/file:
  // session push to a real sheet, even if a live sync URL ends up in
  // localStorage (e.g. pasted for debugging). Timers and dirty state stay
  // untouched here, only the network write is skipped.
  if (isLocalPreview()) { setSyncStatus('local', 'Preview, sync disabled'); return; }

  if (_activeSyncController) { try { _activeSyncController.abort(); } catch(_){} }
  const controller = new AbortController();
  _activeSyncController = controller;

  setSyncStatus('syncing');
  try {
    const body = JSON.stringify(syncPayload());

    if (body.length > PAYLOAD_WARN_AT && !_bloatWarned) {
      _bloatWarned = true;
      const pct = Math.round((body.length / PAYLOAD_HARD_CAP) * 100);
      showToast('Data size at ' + pct + '% of sync limit. Consider trimming changelog.', 'error');
    }
    if (body.length > PAYLOAD_HARD_CAP) {
      setSyncStatus('failed', 'Payload exceeds sync limit.');
      return;
    }

    const pushSignal = (AbortSignal.any && AbortSignal.timeout)
      ? AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
      : controller.signal;
    const resp = await fetch(url, {
      method: 'POST', mode: 'cors', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body, signal: pushSignal
    });
    const parsed = await safeJson(resp);
    if (!parsed.ok) {
      // Apps Script returned HTML (404 from googleusercontent redirect, login
      // page, error page, etc.). Don't crash — log and set failed status.
      console.warn('[sync] non-JSON push response, status', parsed.status, 'body starts:', parsed.text.slice(0, 100));
      setSyncStatus('failed', 'Backend returned non-JSON (status ' + parsed.status + ')');
      return;
    }
    const data = parsed.data;
    if (data.error) {
      // Old backend (pre-A2, no chunked storage) still hard-rejects any body
      // over its single-cell 49,500-char limit with this exact message. A
      // new client sending a bigger payload hits it first, before this
      // check exists on any newer deploy. Surface the same "redeploy"
      // prompt used for the missing-_savedAt case (see pullFromRemote).
      if (/Payload too large/i.test(data.error)) {
        setSyncStatus('failed', 'Backend out of date, redeploy Apps Script.');
        showToast('Backend out of date, redeploy Apps Script (see README) to sync larger payloads.', 'error');
        return;
      }
      throw new Error(data.error);
    }
    if (data.conflict) {
      console.info('[sync] conflict — source:', lastPullSource(), 'strict:', strictConflictsEnabled());
      // Single-user mode default: silently force-push to recover. The
      // mismatch is almost certainly clock drift / Sheets cell-format quirk
      // / race condition — never a real divergence on a personal sheet.
      // Power users can flip "Strict sync conflicts" on in Settings to
      // restore the modal for multi-device usage.
      if (strictConflictsEnabled()) {
        showConflictModal({ remoteAt: data.remoteAt, lastSeenRemoteAt: data.lastSeenRemoteAt, stashedBody: body });
        return;
      }
      // Before force-pushing, verify the remote actually holds the same data.
      // A conflict is usually just clock drift or a Sheets cell-format quirk,
      // but on real two-device use it can be a genuine divergence, another
      // device's edits that a blind force-push would silently discard. Read
      // the remote back and only auto-recover when the data itself matches;
      // otherwise fall through to the same modal strict mode uses.
      let remoteSnapshot;
      try {
        const checkResp = await fetch(url, { method:'GET', mode:'cors', redirect:'follow' });
        const checkParsed = await safeJson(checkResp);
        if (!checkParsed.ok || !checkParsed.data || checkParsed.data.error) throw new Error('unreadable remote');
        remoteSnapshot = checkParsed.data;
      } catch (checkErr) {
        // Can't verify, don't force-push blind.
        setSyncStatus('failed', 'Could not verify cloud state, use Settings to Pull or Push');
        showToast('Sync conflict, could not verify the cloud copy. Use Settings to Pull or Push.', 'error');
        return;
      }
      if (_isMaterialDivergence(JSON.parse(body), remoteSnapshot)) {
        showConflictModal({ remoteAt: data.remoteAt, lastSeenRemoteAt: data.lastSeenRemoteAt, stashedBody: body });
        return;
      }
      // Effectively identical data, safe to auto-recover with one retry. The
      // first attempt sometimes 404s on
      // Apps Script's redirect target (file:// origin + googleusercontent
      // redirect chain). 500 ms backoff usually clears it.
      const recover = async () => {
        const obj = JSON.parse(body);
        delete obj.lastSeenRemoteAt;
        const r = await fetch(url, {
          method:'POST', mode:'cors', redirect:'follow',
          headers:{ 'Content-Type':'text/plain;charset=utf-8' },
          body: JSON.stringify(obj)
        });
        return safeJson(r);
      };
      _conflictResolvingNow = true;
      try {
        let r = await recover();
        if (!r.ok || (r.data && (r.data.error || r.data.conflict))) {
          console.warn('[sync] auto-recovery attempt 1 failed, retrying in 500ms', r);
          await new Promise(res => setTimeout(res, 500));
          r = await recover();
        }
        if (r.ok && !r.data.error && !r.data.conflict) {
          const stamp2 = r.data.savedAt || new Date().toISOString();
          localStorage.setItem(LK_SYNC_TS, stamp2);
          setLastPull(stamp2, 'server');
          setSyncStatus('synced');
          if (!_resyncToastShown) {
            _resyncToastShown = true;
            showToast('Sync resynchronised', 'success');
          }
          return;
        }
        console.warn('[sync] auto-recovery exhausted retries', r);
        setSyncStatus('failed', 'Auto-recovery failed, try Pull from cloud');
        showToast('Sync failed, Settings → Pull from cloud to recover', 'error');
      } catch (recoverErr) {
        console.warn('[sync] auto-recovery threw:', recoverErr.message);
        setSyncStatus('failed', recoverErr.message);
      } finally {
        _conflictResolvingNow = false;
      }
      return;
    }
    const stamp = data.savedAt || new Date().toISOString();
    localStorage.setItem(LK_SYNC_TS, stamp);
    setLastPull(stamp, 'server');  // push response gives us the real server stamp
    setSyncStatus('synced');
  } catch (err) {
    if (err.name === 'AbortError') return; // superseded by a newer push
    if (err.name === 'TimeoutError') {
      setSyncStatus('failed', 'Push timed out after 30 s');
      showToast('Push timed out. Will retry on next save.', 'error');
    } else {
      setSyncStatus('failed', err.message);
    }
  } finally {
    if (_activeSyncController === controller) _activeSyncController = null;
  }
}

async function pullFromRemote(opts){
  const url = getSyncUrl();
  if (!url) { setSyncStatus('local'); return false; }
  setSyncStatus('syncing');
  try {
    const resp = await fetch(url, {
      method:'GET', mode:'cors', redirect:'follow',
      signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    if (data.schema !== SCHEMA){
      // Schema mismatch. seedDecision() (kjr-core.js) decides if seeding is
      // safe. Fail SAFE: if the helper didn't load, never auto-overwrite.
      const decision = (typeof seedDecision === 'function')
        ? seedDecision(data, opts, SCHEMA) : 'refuse';
      if (decision === 'seed'){
        await pushToRemote();   // genuinely empty remote → safe first-run seed
        return true;
      }
      if (decision === 'refuse'){
        // Remote holds financial data under an unexpected schema (e.g. a
        // SCHEMA version bump). Never clobber it — #Crit-1.
        setSyncStatus('failed', 'Remote has data under an unexpected schema, not overwriting.');
        showToast('Cloud has data under a different schema. Not overwriting it. To replace the cloud with this device, use Settings → Push to cloud.', 'error');
        return false;
      }
      throw new Error('Sheet has no ' + SCHEMA + ' data yet. Push first.');
    }
    // Remote no longer carries _priceCache (it is never synced, see syncPayload).
    // mergeDefaults would otherwise reset it to {}, blanking every quote on the
    // Stocks/Watchlist tabs on every pull. Carry the in-memory cache forward.
    const prevPriceCache = DB._priceCache;
    DB = mergeDefaults(data);
    DB._priceCache = Object.assign({}, prevPriceCache, DB._priceCache);
    saveLocal();
    // Prefer the server's C1 timestamp (data._savedAt) — that's what doPost
    // compares lastSeenRemoteAt against. Falling back to data.updatedAt
    // (the client's own timestamp) causes false-positive conflicts after
    // every reload, because C1 always differs slightly from the client's
    // updatedAt. We persist the source flag so the push path can detect
    // a stale client-side stamp and auto-recover even after a reload.
    const hasServerStamp = !!data._savedAt;
    const stamp = data._savedAt || data.updatedAt || new Date().toISOString();
    if (!hasServerStamp) {
      console.warn('[sync] pull response missing _savedAt — backend out of date');
      showToast('Backend out of date, redeploy Apps Script (see README) to stop sync conflicts.', 'error');
    }
    localStorage.setItem(LK_SYNC_TS, stamp);
    setLastPull(stamp, hasServerStamp ? 'server' : 'client');
    setSyncStatus('synced');
    renderAll();
    return true;
  } catch (err) {
    if (err.name === 'TimeoutError') {
      setSyncStatus('failed', 'Pull timed out after 30 s');
      showToast('Pull timed out. Check your connection and try again.', 'error');
    } else {
      setSyncStatus('failed', err.message);
    }
    return false;
  }
}

/* Best-effort flush on tab close. fetch+keepalive instead of sendBeacon
   to allow larger bodies. Send Ops uses the same pattern. */
window.addEventListener('beforeunload', () => {
  if (!_syncTimer) return;
  clearTimeout(_syncTimer); _syncTimer = null;
  const url = getSyncUrl();
  if (!url) return;
  // Preview guard: same rule as pushToRemote, a localhost/file: tab must
  // never fire a real network write on close.
  if (isLocalPreview()) { setSyncStatus('local', 'Preview, sync disabled'); return; }
  const payload = JSON.stringify(syncPayload());
  try {
    fetch(url, { method:'POST', body:payload, keepalive:true, headers:{ 'Content-Type':'text/plain;charset=utf-8' } });
  } catch (_) {
    try { navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain' })); } catch (__) {}
  }
});

/* Cross-tab sync (#High-9): when another tab saves to LK_DB, pick up the
   change and re-render. The storage event fires only in OTHER tabs (not the
   one that wrote), so there is no self-loop. Skip during conflict resolution
   to avoid a mid-flight clobber. */
window.addEventListener('storage', (e) => {
  if (e.key !== LK_DB || !e.newValue) return;
  if (_conflictResolvingNow) return;
  try {
    DB = mergeDefaults(JSON.parse(e.newValue));
    renderAll();
  } catch (_) {}
});

/* ── Event-driven router (#Med-8) ────────────────────────────────────────────
   The URL hash is the single source of truth for the visible tab. Nav clicks,
   the back/forward buttons, and the mobile swipe-back gesture all change the
   hash; hashchange (with popstate as a belt-and-braces) re-derives the tab and
   repaints. showPage() is a pure render primitive that never touches history,
   so the DOM and the URL can no longer drift apart. */
function currentRoute(){
  const k = (location.hash || '').replace(/^#/, '');
  return (Array.isArray(TABS) && TABS.some(t => t.key === k)) ? k : 'dashboard';
}
function route(){ showPage(currentRoute()); }
function navigate(key){
  // Setting a new hash fires hashchange → route(). If the hash is unchanged
  // (re-tapping the active tab) hashchange won't fire, so render directly.
  if (currentRoute() === key) showPage(key);
  else location.hash = '#' + key;
}
window.addEventListener('hashchange', route);
window.addEventListener('popstate', route);

/* ═══════════════════════════════════════════════════════════════════════
   CONFLICT MODAL
   ═══════════════════════════════════════════════════════════════════════ */
function showConflictModal(opts){
  document.getElementById('conflict-modal')?.remove();
  const remoteAgo = opts.remoteAt ? relTime(opts.remoteAt) : 'just now';
  const wrap = document.createElement('div');
  wrap.id = 'conflict-modal';
  wrap.className = 'overlay open';
  wrap.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-head"><h3>⚠ Sync conflict</h3></div>
      <div class="modal-body">
        <div style="color:var(--text2);line-height:1.6">Someone (or another tab) updated the cloud sheet ${kjrEscape(remoteAgo)}. Your local edits haven't been saved yet.</div>
        <div class="stat-box y" style="margin-top:14px;font-family:'SF Mono',monospace;font-size:12px;color:var(--text2);line-height:1.7">
          local: ${DB.stocks.length} stocks · ${DB.crypto.length} crypto · ${DB.cash.length} cash · ${DB.cpfHistory.length} CPF entries · ${DB.income.length} income · ${DB.expenses.length} expenses
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-click="dismissConflict">Keep editing</button>
        <button class="btn" id="cf-pull">Discard local, pull cloud</button>
        <button class="btn btn-danger" id="cf-force">Overwrite cloud with local</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  document.getElementById('cf-pull').onclick = async () => {
    wrap.remove();
    // Same cancellation as cf-force below: a debounced or in-flight push
    // still carries the pre-pull payload and old stamp, and would land
    // right after the pull, conflict again, and reopen this modal in a loop.
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
    if (_activeSyncController) { try { _activeSyncController.abort(); } catch(_){} _activeSyncController = null; }
    await pullFromRemote();
  };
  document.getElementById('cf-force').onclick = async () => {
    wrap.remove();
    // Cancel any pending or in-flight push so force-push has the cloud to
    // itself. Otherwise a debounced push from the auto-refresh tick could
    // land right after, with the OLD stamp, and re-trigger the conflict.
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
    if (_activeSyncController) { try { _activeSyncController.abort(); } catch(_){} _activeSyncController = null; }
    try {
      const obj = JSON.parse(opts.stashedBody);
      delete obj.lastSeenRemoteAt;
      setSyncStatus('syncing');
      const resp = await fetch(getSyncUrl(), {
        method:'POST', mode:'cors', redirect:'follow',
        headers:{ 'Content-Type':'text/plain;charset=utf-8' },
        body: JSON.stringify(obj)
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      const stamp = data.savedAt || new Date().toISOString();
      localStorage.setItem(LK_SYNC_TS, stamp);
      setLastPull(stamp, 'server');
      _firstConflictHandled = true;  // any future conflict is real, not drift
      setSyncStatus('synced');
      showToast('Cloud overwritten with local version', 'success');
    } catch (err) {
      setSyncStatus('failed', err.message);
    }
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   SYNC PILL — visual state
   ═══════════════════════════════════════════════════════════════════════ */
function setSyncStatus(state, detail){
  const pill = document.getElementById('sync-pill');
  if (!pill) return;
  const label = document.getElementById('sync-pill-label') || pill;
  pill.classList.remove('s-local','s-syncing','s-synced','s-failed');
  const ts = localStorage.getItem(LK_SYNC_TS);
  const tsLabel = ts ? ' · ' + relTime(ts) : '';
  let text = '';
  switch (state) {
    case 'local':   pill.classList.add('s-local');   text = 'Local only'; break;
    case 'syncing': pill.classList.add('s-syncing'); text = 'Syncing…'; break;
    case 'synced':  pill.classList.add('s-synced');  text = 'Synced' + tsLabel; break;
    case 'failed':  pill.classList.add('s-failed');  text = 'Sync failed'; break;
  }
  label.textContent = text;
  pill.title = detail || (state === 'synced' ? 'All changes pushed to the cloud' : (state === 'local' ? 'No Apps Script URL set' : ''));
  const det = document.getElementById('sync-status-detail');
  if (det) det.textContent = detail || (ts ? 'Last sync ' + relTime(ts) : 'No sync yet');
  // The pill itself is dot-only on every width now (see index.html), the text
  // moves into the dashboard hero subline instead. Null-checked: the subline
  // only exists while the dashboard is the rendered/current page.
  const heroSync = document.getElementById('dash-hero-sync');
  if (heroSync) heroSync.textContent = text;
}

function updateSyncStatusPill(){
  if (!getSyncUrl()) setSyncStatus('local');
  else if (localStorage.getItem(LK_SYNC_TS)) setSyncStatus('synced');
  else setSyncStatus('local', 'URL saved, run a pull or push to sync');
}

async function manualSync(){
  if (!getSyncUrl()) { navigate('settings'); showToast('Set the Apps Script URL first'); return; }
  await pushToRemote();
}

async function manualPull(){
  if (!getSyncUrl()) { showToast('Set the Apps Script URL first', 'error'); return; }
  const ok = await pullFromRemote({ allowSeed: true });
  if (ok) showToast('Pulled from cloud', 'success');
}

async function manualPush(){
  if (!getSyncUrl()) { showToast('Set the Apps Script URL first', 'error'); return; }
  await pushToRemote();
  if (document.getElementById('sync-pill').classList.contains('s-synced')) showToast('Pushed to cloud', 'success');
}

function saveSyncUrlFromForm(){
  const v = document.getElementById('cfg-sync-url').value.trim();
  // Validate the URL is the Apps Script form, not something random pasted in
  if (v && !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(\?.*)?$/.test(v)){
    if (!confirm('That URL does not look like a Google Apps Script Web App URL. Save anyway?')) return;
  }
  setSyncUrl(v);
  showToast(v ? 'URL saved' : 'URL cleared', 'success');
  renderDiagnostics();
}

/* ─── Setup wizard ──────────────────────────────────────────────────────
   Four-step onboarding for first-time users. Steps:
     1. Create a Google Sheet
     2. Open Apps Script editor and paste the code
     3. Deploy as Web app and copy the URL
     4. Paste the URL into the app
   We auto-open on first launch (no DB + no URL set). User can dismiss with
   "Skip" — we set a localStorage flag so we don't pester them every reload. */
const LK_WIZARD_DISMISSED = 'kjr-pf-wizard-dismissed-v1';
let _swStep = 1;

function openSetupWizard(){
  _swStep = 1;
  document.getElementById('setup-wizard').classList.add('open');
  renderSetupWizardStep();
}

function closeSetupWizard(){
  document.getElementById('setup-wizard').classList.remove('open');
  localStorage.setItem(LK_WIZARD_DISMISSED, '1');
}

function setupWizardNext(){
  if (_swStep === 4){
    // Final step: try to save the URL the user pasted in the wizard
    const v = (document.getElementById('sw-url-input')?.value || '').trim();
    if (v){
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(\?.*)?$/.test(v)){
        if (!confirm('That URL does not look like a Google Apps Script Web App URL. Save anyway?')) return;
      }
      setSyncUrl(v);
      showToast('Connected, pulling your data', 'success');
      closeSetupWizard();
      pullFromRemote({ allowSeed: true });
      return;
    }
    closeSetupWizard();
    return;
  }
  _swStep++;
  renderSetupWizardStep();
}

function setupWizardBack(){
  if (_swStep > 1) _swStep--;
  renderSetupWizardStep();
}

function renderSetupWizardStep(){
  const body = document.getElementById('sw-body');
  const back = document.getElementById('sw-back');
  const next = document.getElementById('sw-next');
  if (!body) return;

  document.querySelectorAll('#sw-steps .sw-dot').forEach(d => {
    const n = Number(d.dataset.step);
    d.classList.toggle('active', n === _swStep);
    d.classList.toggle('done',   n <  _swStep);
  });

  back.style.display = _swStep > 1 ? '' : 'none';
  next.textContent   = _swStep === 4 ? 'Save URL & finish' : 'Next';

  if (_swStep === 1){
    body.innerHTML = `<div class="sw-step">
      <h4>Step 1: Create a Google Sheet</h4>
      <p>You'll need an empty Google Sheet to hold your data. Only you will have access to it. We never see it.</p>
      <ol>
        <li>Click the button below to open Google Sheets in a new tab.</li>
        <li>Click <strong>+ Blank</strong> to create a new sheet.</li>
        <li>Give it a name like <em>My Portfolio Tracker</em>.</li>
        <li>Leave the tab open, you'll come back to it.</li>
      </ol>
      <div class="actions">
        <a class="btn btn-primary" href="https://sheets.new" target="_blank" rel="noopener noreferrer">Open Google Sheets</a>
      </div>
    </div>`;
  } else if (_swStep === 2){
    body.innerHTML = `<div class="sw-step">
      <h4>Step 2: Paste the Apps Script code</h4>
      <p>In your new Google Sheet:</p>
      <ol>
        <li>Click <strong>Extensions → Apps Script</strong> in the menu.</li>
        <li>Delete whatever code is already there.</li>
        <li>Open the backend code (button below), click <strong>Copy raw file</strong>, and paste it in.</li>
        <li>Click <strong>Save</strong> (disk icon).</li>
        <li>Click the function dropdown, pick <code>initOnce</code>, then <strong>▶ Run</strong>. Grant the permissions Google asks for, it needs to read/write your sheet and call Yahoo Finance / CoinGecko.</li>
      </ol>
      <div class="actions">
        <a class="btn btn-primary" href="https://github.com/julianchow21/Kujira-Portfolio/blob/main/Portfolio/apps-script.gs" target="_blank" rel="noopener noreferrer">Open the backend code</a>
      </div>
    </div>`;
  } else if (_swStep === 3){
    body.innerHTML = `<div class="sw-step">
      <h4>Step 3: Deploy as a Web App</h4>
      <p>Still in the Apps Script editor:</p>
      <ol>
        <li>Click <strong>Deploy → New deployment</strong>.</li>
        <li>Click the gear icon next to <em>Select type</em>, pick <strong>Web app</strong>.</li>
        <li>Description: <em>My Portfolio Tracker</em>.</li>
        <li>Execute as: <strong>Me</strong>.</li>
        <li>Who has access: <strong>Anyone</strong>.</li>
        <li>Click <strong>Deploy</strong> and copy the Web app URL (ends in <code>/exec</code>).</li>
      </ol>
      <p style="background:var(--amber-soft);border:1px solid var(--amber-border);color:var(--amber);padding:10px;border-radius:8px;font-size:12px">
        ⚠ The URL is your credential. Treat it like a password. Anyone with the URL can read and write your sheet. Don't share it.
      </p>
    </div>`;
  } else if (_swStep === 4){
    body.innerHTML = `<div class="sw-step">
      <h4>Step 4: Paste the URL here</h4>
      <p>Paste the URL you copied from the deploy dialog. We'll save it locally and pull your data.</p>
      <input type="url" id="sw-url-input" class="fi" placeholder="https://script.google.com/macros/s/.../exec" spellcheck="false" autocomplete="off">
      <p style="margin-top:14px;font-size:12px;color:var(--text3)">The URL is stored only in this browser. We never transmit it anywhere except to your own Apps Script.</p>
    </div>`;
    setTimeout(() => document.getElementById('sw-url-input')?.focus(), 100);
  }
}

function maybeShowWizardOnBoot(){
  // First-launch: no sync URL set AND no dismissed flag AND DB looks empty
  if (!navigator.onLine) return; // backend setup needs the network; degrade to the dashboard
  if (getSyncUrl()) return;
  if (localStorage.getItem(LK_WIZARD_DISMISSED)) return;
  if (DB.stocks.length || DB.crypto.length || DB.cash.length || DB.realestate.length || DB.cpfHistory.length) return;
  openSetupWizard();
}

/* ═══════════════════════════════════════════════════════════════════════
   SETTINGS FORM
   ═══════════════════════════════════════════════════════════════════════ */
function loadSettingsForm(){
  const s = DB.settings;
  const setV = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v == null ? '' : v); };
  setV('cfg-sync-url',         getSyncUrl());
  const arCheckbox = document.getElementById('cfg-auto-refresh');
  if (arCheckbox) arCheckbox.checked = autoRefreshEnabled();
  const arMeta = document.getElementById('auto-refresh-meta');
  if (arMeta) {
    const onMarketDay = isStockMarketDaySGT();
    arMeta.textContent = autoRefreshEnabled()
      ? (onMarketDay ? 'Active · stocks+crypto every 60s' : 'Active · crypto only (weekend SGT)')
      : 'Paused';
  }
  const scCheckbox = document.getElementById('cfg-strict-conflicts');
  if (scCheckbox) scCheckbox.checked = strictConflictsEnabled();
  setV('cfg-base-currency',    s.baseCurrency || 'SGD');
  setV('cfg-fx-usdsgd',        s.fxOverrides && s.fxOverrides.USDSGD);
  setV('cfg-birth-year',       s.birthYear);
  setV('cfg-retirement-age',   s.retirementAge);
  setV('cfg-expected-return',  s.expectedReturn);
  setV('cfg-inflation',        s.inflationRate);
  setV('cfg-fire-multiple',    s.fireMultiple);
  setV('cfg-fire-target',      s.fireTarget);
  setV('cfg-cpf-oa',           s.cpfRates.OA);
  setV('cfg-cpf-sa',           s.cpfRates.SA);
  setV('cfg-cpf-ma',           s.cpfRates.MA);
  setV('cfg-cpf-ra',           s.cpfRates.RA);
  setV('cfg-cpf-extra60',      s.cpfRates.extraFirst60k);
  setV('cfg-cpf-extra30',      s.cpfRates.extraFirst30kAge55);
  loadCpfBalancesForm();
  const cpfAnchorMeta = document.getElementById('cfg-cpf-anchor-meta');
  if (cpfAnchorMeta){ const an = _cpfAnchorDate(); cpfAnchorMeta.textContent = an ? 'Anchored ' + fmtDateSG(an) : 'Not set yet'; }
  const sal = s.salary || {};
  setV('cfg-salary-employer',  sal.employer);
  setV('cfg-salary-gross',     sal.grossMonthly);
  setV('cfg-salary-start',     sal.startDate);
  setV('cfg-salary-end',       sal.endDate);
  setV('cfg-salary-bonus',     sal.annualBonus);
  setV('cfg-salary-bonus-month', sal.bonusMonth);
  setV('cfg-salary-savepct',   s.salarySavePct == null ? 50 : s.salarySavePct);
  // Salary-account dropdown: SGD cash accounts only (take-home is computed in SGD).
  const sgdAccts = (DB.cash || []).filter(c => (c.currency || 'SGD') === 'SGD');
  const salAcctSel = document.getElementById('cfg-salary-account');
  if (salAcctSel){
    salAcctSel.innerHTML = '<option value="">— none (off) —</option>' +
      sgdAccts.map(c => `<option value="${kjrEscape(c.id)}"${s.salaryAccountId === c.id ? ' selected' : ''}>${kjrEscape(c.name || '?')}</option>`).join('');
  }
  const salDiscSel = document.getElementById('cfg-salary-discretionary');
  if (salDiscSel){
    salDiscSel.innerHTML = '<option value="">— none —</option>' +
      sgdAccts.map(c => `<option value="${kjrEscape(c.id)}"${s.salaryDiscretionaryAccountId === c.id ? ' selected' : ''}>${kjrEscape(c.name || '?')}</option>`).join('');
  }
  // Target allocation + emergency fund
  const tg = s.targets || {};
  setV('cfg-target-stocks',     tg.stocks || '');
  setV('cfg-target-cash',       tg.cash || '');
  setV('cfg-target-cpf',        tg.cpf || '');
  setV('cfg-target-realestate', tg.realestate || '');
  setV('cfg-target-crypto',     tg.crypto || '');
  setV('cfg-rebalance-threshold', s.rebalanceThreshold || 5);
  setV('cfg-ef-target',         s.efTarget || '');
  updateTargetSumHint();
  // Income tax
  const tax = s.tax || {};
  const taxResSel = document.getElementById('cfg-tax-residency');
  if (taxResSel) taxResSel.value = tax.residency || 'resident';
  setV('cfg-tax-reliefs', tax.totalReliefs != null ? tax.totalReliefs : 1000);
  setV('cfg-tax-manual',  tax.manualAnnualTax != null ? tax.manualAnnualTax : '');
  renderTaxEstimate();
  // Salary allocation rules
  renderSalaryRulesEditor();
  // Recently deleted (trash)
  renderTrash();
}

/* Live sum hint for the target allocation inputs. */
function updateTargetSumHint(){
  const el = document.getElementById('cfg-target-sum');
  if (!el) return;
  const ids = ['cfg-target-stocks','cfg-target-cash','cfg-target-cpf','cfg-target-realestate','cfg-target-crypto'];
  const sum = ids.reduce((s,id) => { const v = Number((document.getElementById(id)||{}).value); return s + (isFinite(v)?v:0); }, 0);
  if (sum === 0){ el.textContent = 'Set a percentage per class. They should total 100%.'; el.style.color = ''; return; }
  el.textContent = 'Targets total ' + sum + '%' + (sum === 100 ? ' ✓' : ' (should be 100%)');
  el.style.color = sum === 100 ? 'var(--green)' : 'var(--amber)';
}

function saveSettingsFromForm(){
  const numOrNull = (id) => {
    const v = document.getElementById(id).value;
    if (v === '' || v == null) return null;
    const n = Number(v); return isNaN(n) ? null : n;
  };
  const s = DB.settings;
  s.baseCurrency               = document.getElementById('cfg-base-currency').value || 'SGD';
  s.fxOverrides.USDSGD         = numOrNull('cfg-fx-usdsgd');
  s.birthYear                  = numOrNull('cfg-birth-year');
  s.retirementAge              = numOrNull('cfg-retirement-age')  || 65;
  s.expectedReturn             = numOrNull('cfg-expected-return') ?? 6.0;
  s.inflationRate              = numOrNull('cfg-inflation')       ?? 3.0;
  s.fireMultiple               = numOrNull('cfg-fire-multiple')   || 25;
  s.fireTarget                 = numOrNull('cfg-fire-target');
  s.cpfRates.OA                = numOrNull('cfg-cpf-oa')          ?? CPF_DEFAULTS.OA;
  s.cpfRates.SA                = numOrNull('cfg-cpf-sa')          ?? CPF_DEFAULTS.SA;
  s.cpfRates.MA                = numOrNull('cfg-cpf-ma')          ?? CPF_DEFAULTS.MA;
  s.cpfRates.RA                = numOrNull('cfg-cpf-ra')          ?? CPF_DEFAULTS.RA;
  s.cpfRates.extraFirst60k     = numOrNull('cfg-cpf-extra60')     ?? CPF_DEFAULTS.extraFirst60k;
  s.cpfRates.extraFirst30kAge55 = numOrNull('cfg-cpf-extra30')    ?? CPF_DEFAULTS.extraFirst30kAge55;
  const strOrEmpty = (id) => { const el = document.getElementById(id); return el ? (el.value || '').trim().slice(0, 80) : ''; };
  const dateOrNull = (id) => { const el = document.getElementById(id); const v = el ? el.value : ''; return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; };
  if (!s.salary) s.salary = {};
  s.salary.employer     = strOrEmpty('cfg-salary-employer');
  s.salary.grossMonthly = numOrNull('cfg-salary-gross');
  s.salary.startDate    = dateOrNull('cfg-salary-start');
  s.salary.endDate      = dateOrNull('cfg-salary-end');
  s.salary.annualBonus  = numOrNull('cfg-salary-bonus');
  s.salary.bonusMonth   = numOrNull('cfg-salary-bonus-month');
  // Salary auto-deposit config.
  s.salaryAccountId = strOrEmpty('cfg-salary-account');
  s.salaryDiscretionaryAccountId = strOrEmpty('cfg-salary-discretionary');
  if (s.salaryDiscretionaryAccountId === s.salaryAccountId) s.salaryDiscretionaryAccountId = ''; // can't be the same account
  const _savePct = numOrNull('cfg-salary-savepct');
  s.salarySavePct = _savePct == null ? 50 : Math.max(0, Math.min(100, _savePct));
  // Stamp the enable date the first time an account is set, so deposits start
  // from the next payday and never backfill over the typed opening balance.
  if (s.salaryAccountId && !s.salaryCashEnabledAt) s.salaryCashEnabledAt = _isoDate(new Date());
  if (!s.salaryAccountId) s.salaryCashEnabledAt = '';   // off resets the boundary
  // Target allocation + emergency fund
  if (!s.targets) s.targets = {};
  const clampPct = (id) => { const v = numOrNull(id); return v == null ? 0 : Math.max(0, Math.min(100, v)); };
  s.targets.stocks     = clampPct('cfg-target-stocks');
  s.targets.cash       = clampPct('cfg-target-cash');
  s.targets.cpf        = clampPct('cfg-target-cpf');
  s.targets.realestate = clampPct('cfg-target-realestate');
  s.targets.crypto     = clampPct('cfg-target-crypto');
  s.rebalanceThreshold = numOrNull('cfg-rebalance-threshold') || 5;
  s.efTarget           = numOrNull('cfg-ef-target');
  // Income tax
  if (!s.tax) s.tax = {};
  const taxResSel = document.getElementById('cfg-tax-residency');
  s.tax.residency       = taxResSel ? (taxResSel.value || 'resident') : 'resident';
  const taxReliefs      = numOrNull('cfg-tax-reliefs');
  s.tax.totalReliefs    = taxReliefs != null ? taxReliefs : 1000;
  s.tax.manualAnnualTax = numOrNull('cfg-tax-manual');
  saveData();
  runSalaryEngine({ rerender: true, notify: true }); // backfill/refresh auto entries
  renderAll(); // base-currency change reconverts every tab + syncs the toggle
  showToast('Settings saved', 'success');
  renderDiagnostics();
}

/* ─── Salary allocation rules (Settings) ───────────────────────────────
   Editable list of { id, name, pct, dest }. The bucket preview multiplies
   each pct by the monthly take-home (gross minus employee CPF). */
function renderSalaryRulesEditor(){
  const host = document.getElementById('cfg-salary-rules');
  if (!host) return;
  const rules = (DB.settings.salaryRules || []);
  if (!rules.length){
    host.innerHTML = '<div class="hint">No rules yet. Add one to split your take-home (e.g. 25% Invest, 10% Savings, 65% Spending).</div>';
  } else {
    host.innerHTML = rules.map((r, i) => `
      <div class="rule-row" data-rule-idx="${i}">
        <input class="fi" type="text" value="${kjrEscape(r.name||'')}" placeholder="Bucket name" data-rule-field="name" data-input="onSalaryRuleInput">
        <input class="fi" type="number" step="1" min="0" max="100" value="${r.pct==null?'':r.pct}" placeholder="%" data-rule-field="pct" data-input="onSalaryRuleInput">
        <input class="fi" type="text" value="${kjrEscape(r.dest||'')}" placeholder="Destination (optional)" data-rule-field="dest" data-input="onSalaryRuleInput">
        <button class="btn btn-sm btn-danger" data-click="removeSalaryRule" data-a0="${i}" title="Remove">✕</button>
      </div>`).join('');
  }
  updateRulesSumHint();
  renderBucketPreview();
}
function _readSalaryRulesFromEditor(){
  const rows = [].slice.call(document.querySelectorAll('#cfg-salary-rules .rule-row'));
  return rows.map(row => {
    const get = (f) => { const el = row.querySelector('[data-rule-field="'+f+'"]'); return el ? el.value : ''; };
    return {
      id:   uid('rule'),
      name: (get('name')||'').trim().slice(0,60),
      pct:  Math.max(0, Math.min(100, Number(get('pct'))||0)),
      dest: (get('dest')||'').trim().slice(0,60)
    };
  });
}
function onSalaryRuleInput(){ updateRulesSumHint(); renderBucketPreview(); }
function addSalaryRule(){
  if (!Array.isArray(DB.settings.salaryRules)) DB.settings.salaryRules = [];
  // capture any in-progress edits first so they aren't lost on re-render
  DB.settings.salaryRules = _readSalaryRulesFromEditor();
  DB.settings.salaryRules.push({ id: uid('rule'), name:'', pct:0, dest:'' });
  renderSalaryRulesEditor();
}
function removeSalaryRule(idx){
  DB.settings.salaryRules = _readSalaryRulesFromEditor().filter((_, i) => i !== idx);
  renderSalaryRulesEditor();
}
function saveSalaryRulesFromForm(){
  DB.settings.salaryRules = _readSalaryRulesFromEditor().filter(r => r.name || r.pct);
  saveData();
  renderSalaryRulesEditor();
  showToast('Salary rules saved', 'success');
}
function updateRulesSumHint(){
  const el = document.getElementById('cfg-rules-sum');
  if (!el) return;
  const rules = _readSalaryRulesFromEditor();
  const sum = rules.reduce((s,r) => s + (Number(r.pct)||0), 0);
  if (!rules.length){ el.textContent = ''; return; }
  el.textContent = 'Allocated ' + sum + '%' + (sum === 100 ? ' ✓' : ' (' + (100 - sum) + '% unallocated)');
  el.style.color = sum === 100 ? 'var(--green)' : 'var(--amber)';
}
/* This-month bucket preview: take-home × each rule's pct. */
function renderBucketPreview(){
  const el = document.getElementById('cfg-bucket-preview');
  if (!el) return;
  const sal = DB.settings.salary || {};
  const rules = _readSalaryRulesFromEditor().filter(r => r.name || r.pct);
  if (!sal.grossMonthly){ el.innerHTML = '<div class="hint">Set a gross monthly salary above to preview the split.</div>'; return; }
  if (!rules.length){ el.innerHTML = ''; return; }
  const age = _ageOnYear(new Date().getFullYear());
  const cpf = computeCpfContribution(sal.grossMonthly, age);
  const takeHome = cpf.net;  // gross minus employee CPF, SGD
  const cells = rules.map(r => {
    const amt = takeHome * (Number(r.pct)||0) / 100;
    return `<div class="bucket">
      <div class="bucket-label">${kjrEscape(r.name||'(unnamed)')}</div>
      <div class="bucket-amt">${fmt(amt,{dp:0})}</div>
      <div class="bucket-sub">${(Number(r.pct)||0)}%${r.dest ? ' → ' + kjrEscape(r.dest) : ''}</div>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="hint" style="margin-bottom:6px">This month on take-home of ${fmt(takeHome,{dp:0})}${cpf.allocated===false&&age==null?' (set birth year for exact CPF)':''}:</div><div class="bucket-grid">${cells}</div>`;
}

/* ─── SG Income Tax engine ──────────────────────────────────────────────
   Finance model:
   - Tax is annual (Year of Assessment), progressive, on chargeable income.
   - Chargeable income = annual gross (12×monthly + bonus) − annual employee
     CPF (capped at OW ceiling × 12) − total reliefs.
   - Resident: progressive brackets (SG_TAX_BRACKETS).
   - Non-resident: employment income taxed at HIGHER of 15% flat or graduated.
   - Monthly provision = annual tax ÷ 12 (accrual, not PAYE withholding).
   Verified against IRAS worked examples at $40k, $80k, $120k.
   computeSgIncomeTax itself now lives in kjr-core.js (pure, unit-tested under
   node) and is used here as a kjr-core global, loaded before this file. */

/* Returns a breakdown object or null if salary is not configured.
   Memo key is a JSON snapshot of the relevant inputs for cheap dirty-check. */
function estimateAnnualTax(){
  const sal = DB.settings.salary || {};
  const tax = DB.settings.tax || {};
  const gross = Number(sal.grossMonthly) || 0;
  if (!gross) return null;

  const bonus           = Number(sal.annualBonus) || 0;
  const annualGross     = gross * 12 + bonus;

  // Annual employee CPF relief. Ordinary Wage leg: monthly OW ceiling × 12.
  // Additional Wage leg (bonus): the AW subject to CPF is capped at the annual
  // AW ceiling of $102,000 minus the OW that attracted CPF this year, so a
  // bonus above that cap earns no further CPF relief. Both legs use the
  // employee rate for the person's age band.
  const age          = _ageOnYear(new Date().getFullYear());
  const rates        = cpfContribRatesForAge(age);
  const monthlyWage  = Math.min(gross, CPF_OW_CEILING_2026);
  const owForCpf     = monthlyWage * 12;
  const awCeiling    = Math.max(0, 102000 - owForCpf);
  const awSubject    = Math.min(bonus, awCeiling);
  const annualEmpCpf = (owForCpf + awSubject) * (rates.employee / 100);

  const reliefs         = Math.max(0, Number(tax.totalReliefs) || 0);
  const chargeableIncome = Math.max(0, annualGross - annualEmpCpf - reliefs);

  let annualTax;
  if (tax.manualAnnualTax != null){
    annualTax = Math.max(0, Number(tax.manualAnnualTax) || 0);
  } else if (tax.residency === 'non-resident'){
    // Non-resident employment income: higher of 15% flat on gross employment
    // income or the graduated tax on chargeable income (IRAS rule). The flat
    // leg does not net off CPF or personal reliefs.
    const graduated = computeSgIncomeTax(chargeableIncome);
    const flat      = annualGross * 0.15;
    annualTax       = Math.max(graduated, flat);
  } else {
    annualTax = computeSgIncomeTax(chargeableIncome);
  }

  const effectiveRate = chargeableIncome > 0 ? annualTax / chargeableIncome * 100 : 0;

  return {
    annualGross, annualEmpCpf, reliefs, chargeableIncome,
    annualTax: _round2(annualTax),
    effectiveRate: Math.round(effectiveRate * 100) / 100,
    monthlyProvision: _round2(annualTax / 12),
    residency: tax.residency || 'resident',
    isManual: tax.manualAnnualTax != null
  };
}

/* Render the tax estimate preview inside the Settings card. */
function renderTaxEstimate(){
  const el = document.getElementById('cfg-tax-estimate');
  if (!el) return;
  const est = estimateAnnualTax();
  if (!est){
    el.innerHTML = '<div class="hint">Set a gross monthly salary in the Salary card above to see an estimate.</div>';
    return;
  }
  const fmt2 = n => n.toLocaleString('en-SG', { style:'currency', currency:'SGD', minimumFractionDigits:0, maximumFractionDigits:0 });
  const nr = est.residency === 'non-resident';
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:10px">
      <div class="hint-block">
        <div class="hint" style="font-size:12px;margin-bottom:2px">Annual gross</div>
        <div style="font-weight:600">${fmt2(est.annualGross)}</div>
      </div>
      <div class="hint-block">
        <div class="hint" style="font-size:12px;margin-bottom:2px">Less employee CPF</div>
        <div style="font-weight:600">(${fmt2(est.annualEmpCpf)})</div>
        <div class="hint" style="font-size:11px">incl. CPF on bonus</div>
      </div>
      <div class="hint-block">
        <div class="hint" style="font-size:12px;margin-bottom:2px">Less reliefs</div>
        <div style="font-weight:600">(${fmt2(est.reliefs)})</div>
      </div>
      <div class="hint-block">
        <div class="hint" style="font-size:12px;margin-bottom:2px">Chargeable income</div>
        <div style="font-weight:600">${fmt2(est.chargeableIncome)}</div>
      </div>
      <div class="hint-block" style="border-left:2px solid var(--accent);padding-left:10px">
        <div class="hint" style="font-size:12px;margin-bottom:2px">Est. annual tax${est.isManual ? ' (manual override)' : ''}</div>
        <div style="font-weight:700;font-size:16px">${fmt2(est.annualTax)}</div>
        <div class="hint">${est.effectiveRate.toFixed(2)}% effective rate${nr ? ' (non-resident, higher of 15% flat / graduated)' : ''}</div>
      </div>
      <div class="hint-block" style="border-left:2px solid var(--accent);padding-left:10px">
        <div class="hint" style="font-size:12px;margin-bottom:2px">Monthly provision</div>
        <div style="font-weight:700;font-size:16px">${fmt2(est.monthlyProvision)}</div>
        <div class="hint">Accrual. SG has no monthly PAYE.</div>
      </div>
    </div>
    <div class="hint" style="margin-top:10px;font-size:12px">Rates: YA2025 resident brackets (IRAS). Estimate only, does not account for NSman or dependent reliefs beyond the "Total reliefs" field. Verify on mytax.iras.gov.sg before filing.</div>
  `;
}

function resetLocalConfirm(){
  if (!confirm('Reset local data? This wipes the browser cache but keeps your cloud sheet intact. You can pull from cloud to restore.')) return;
  localStorage.removeItem(LK_DB);
  localStorage.removeItem(LK_SYNC_TS);
  localStorage.removeItem(LK_LAST_PULL);
  localStorage.removeItem(LK_LAST_PULL_SRC);
  DB = freshDB();
  loadSettingsForm();
  renderAll();
  showToast('Local data reset. Pull from cloud to restore.', 'success');
}

/* ═══════════════════════════════════════════════════════════════════════
   BACKUP / RESTORE — download or load the whole DB as a JSON file.
   The safety net for local-only users (no cloud sync configured). Export is
   the full DB minus the transient price cache; import runs through
   mergeDefaults (same validation as a cloud pull) so a malformed or hostile
   file cannot corrupt the app. Import always confirms before overwriting.
   ═══════════════════════════════════════════════════════════════════════ */
function exportBackup(){
  try {
    const payload = Object.assign({}, localPersistPayload(), {
      _backup: { app: 'kujira-portfolio', appVersion: APP_VERSION, exportedAt: new Date().toISOString() }
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = _isoDate(new Date());
    a.href = url;
    a.download = 'kujira-portfolio-backup-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const meta = document.getElementById('backup-meta');
    if (meta) meta.textContent = 'Exported ' + stamp;
    showToast('Backup downloaded', 'success');
  } catch (e) {
    showToast('Export failed: ' + (e && e.message ? e.message : e), 'error');
  }
}

function importBackupFromFile(input){
  const file = input && input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => { showToast('Could not read that file', 'error'); input.value = ''; };
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch (e) {
      showToast('That is not a valid JSON backup file', 'error');
      input.value = '';
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)){
      showToast('That file does not look like a portfolio backup', 'error');
      input.value = '';
      return;
    }
    // Soft check: a real backup has at least one known table or our marker.
    const known = ['stocks','cash','cpfHistory','income','expenses','settings','_backup'];
    if (!known.some(k => k in parsed)){
      showToast('That file does not look like a portfolio backup', 'error');
      input.value = '';
      return;
    }
    const stampTxt = (parsed._backup && parsed._backup.exportedAt)
      ? ('\n\nBackup date: ' + parsed._backup.exportedAt) : '';
    if (!confirm('Import this backup? It REPLACES all current data in this browser.' + stampTxt + '\n\nTip: export your current data first if you might want it back.')) {
      input.value = '';
      return;
    }
    try {
      DB = mergeDefaults(parsed);   // same validation path as a cloud pull
      saveLocal();
      loadSettingsForm();
      runSalaryEngine({});
      renderAll();
      navigate('dashboard');
      const meta = document.getElementById('backup-meta');
      if (meta) meta.textContent = 'Imported ' + _isoDate(new Date());
      showToast('Backup imported', 'success');
    } catch (e) {
      showToast('Import failed: ' + (e && e.message ? e.message : e), 'error');
    }
    input.value = '';  // allow re-importing the same file name
  };
  reader.readAsText(file);
}

/* ═══════════════════════════════════════════════════════════════════════
   DIAGNOSTICS — handy for verification
   ═══════════════════════════════════════════════════════════════════════ */
/* Diagnostics is intentionally terse and never prints the URL or its length.
   Knowing the URL length narrows brute-force guessing slightly; some screen-
   recording tutorial videos have leaked this kind of metadata. */
function renderDiagnostics(){
  const out = document.getElementById('diag-output');
  if (!out) return;
  const ts   = localStorage.getItem(LK_SYNC_TS);
  const last = localStorage.getItem(LK_LAST_PULL);
  const lines = [
    'App version    : ' + APP_VERSION,
    'Schema         : ' + SCHEMA,
    'Apps Script URL: ' + (getSyncUrl() ? '✓ set' : '✗ not set'),
    'Last sync (TS) : ' + (ts ? ts + ' (' + relTime(ts) + ')' : '—'),
    'Last pull seen : ' + (last || '—'),
    'Theme          : ' + (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
    'Local rows     : ' +
      'stocks=' + DB.stocks.length +
      ' crypto=' + DB.crypto.length +
      ' realestate=' + DB.realestate.length +
      ' cash=' + DB.cash.length +
      ' cpfHistory=' + DB.cpfHistory.length +
      ' income=' + DB.income.length +
      ' expenses=' + DB.expenses.length,
    'Settings       : base=' + DB.settings.baseCurrency +
      ' birthYear=' + (DB.settings.birthYear || '—') +
      ' retireAge=' + (DB.settings.retirementAge || '—') +
      ' return=' + DB.settings.expectedReturn + '%' +
      ' inflation=' + DB.settings.inflationRate + '%'
  ];
  out.textContent = lines.join('\n');

  // D6: constants ageing. CPF, tax and holiday tables are only reviewed
  // through CONSTANTS_VERIFIED_FOR (kjr-core.js). Warn once the calendar
  // outruns that review, never fabricate figures for years not checked.
  // Refresh diagnostics can be clicked repeatedly, so drop any prior warning
  // node before deciding whether to add a fresh one.
  const prevWarn = document.getElementById('diag-constants-warning');
  if (prevWarn) prevWarn.remove();
  const thisYear = new Date().getFullYear();
  if (thisYear > CONSTANTS_VERIFIED_FOR){
    const warn = document.createElement('div');
    warn.id = 'diag-constants-warning';
    warn.style.cssText = 'margin-top:10px;background:var(--amber-soft);border:1px solid var(--amber-border);color:var(--amber);padding:10px;border-radius:8px;font-size:12px';
    warn.textContent = '⚠ CPF, tax and holiday constants last verified for ' + CONSTANTS_VERIFIED_FOR + '. Verify against CPF Board, IRAS and MOM before trusting ' + (CONSTANTS_VERIFIED_FOR + 1) + '+ figures.';
    out.after(warn);
  }
}

/* Reveal/hide the Apps Script URL. Default state is hidden (type=password).
   When revealed, ask for explicit confirmation since the URL is a credential. */
function toggleSyncUrlReveal(){
  const input = document.getElementById('cfg-sync-url');
  const btn   = document.getElementById('btn-toggle-url');
  if (!input || !btn) return;
  if (input.type === 'password'){
    if (!confirm('Reveal the Apps Script URL? Anyone who sees it can read and write your sheet. Make sure no one is looking over your shoulder or screen-sharing.')) return;
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
}

/* Scrub URLs from any string before printing — Apps Script URLs follow a
   predictable pattern, so this redacts any /macros/s/<id>/exec sub-paths. */
function redactUrls(s){
  return String(s).replace(/https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/g, 'https://script.google.com/macros/s/<REDACTED>/exec')
                  .replace(/https:\/\/script\.googleusercontent\.com\/[^\s"']+/g, 'https://script.googleusercontent.com/<REDACTED>');
}

async function testPriceFetch(){
  if (!getSyncUrl()) { showToast('Set the Apps Script URL first', 'error'); return; }
  showToast('Fetching test prices…');
  try {
    const url = getSyncUrl() + (getSyncUrl().includes('?') ? '&' : '?') + 'action=prices&symbols=AAPL,D05.SI';
    const resp = await fetch(url, { method:'GET', mode:'cors', redirect:'follow' });
    const data = await resp.json();
    const out = document.getElementById('diag-output');
    if (out) out.textContent += '\n\nPrice test:\n' + redactUrls(JSON.stringify(data, null, 2));
    showToast(data.error ? ('Price test failed: ' + redactUrls(data.error)) : 'Price test OK', data.error ? 'error' : 'success');
  } catch (err) {
    showToast('Price test failed: ' + redactUrls(err.message), 'error');
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   NAV / ROUTING
   ═══════════════════════════════════════════════════════════════════════ */
const MORE_SHEET_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>';

function renderNav(){
  const host  = document.getElementById('nav-host');
  const bhost = document.getElementById('bottom-nav');
  if (host)  host.innerHTML  = '';
  if (bhost) bhost.innerHTML = '';

  // Desktop topbar: unchanged, every tab except Settings (shown via the cog icon).
  TABS.forEach(t => {
    if (t.key === 'settings') return;
    const btn = document.createElement('button');
    btn.className = 'nav-btn'; btn.dataset.tab = t.key;
    const chip = PHASE_2_TABS.has(t.key) ? '<span class="phase-chip-mini">P2</span>' : '';
    btn.innerHTML = t.icon + '<span>' + t.label + chip + '</span>';
    btn.onclick = () => navigate(t.key);
    if (host) host.appendChild(btn);
  });

  // Mobile bottom bar: exactly 5 fixed destinations, MOBILE_BOTTOM_TABS in
  // order, plus a "More" button that opens the sheet with everything else.
  if (bhost) {
    MOBILE_BOTTOM_TABS.forEach(key => {
      const t = TABS.find(x => x.key === key);
      if (!t) return;
      const btn = document.createElement('button');
      btn.className = 'nav-btn'; btn.dataset.tab = t.key;
      btn.innerHTML = t.icon + '<span>' + t.label + '</span>';
      btn.onclick = () => navigate(t.key);
      bhost.appendChild(btn);
    });
    const moreBtn = document.createElement('button');
    moreBtn.className = 'nav-btn'; moreBtn.dataset.tab = 'more';
    moreBtn.innerHTML = MORE_SHEET_ICON + '<span>More</span>';
    moreBtn.onclick = () => openMoreSheet();
    bhost.appendChild(moreBtn);
  }

  renderMoreSheet();
}

/* Tabs reachable only through the More sheet on mobile: every TABS entry not
   already pinned to the bottom bar, in TABS order (Settings included). */
function _moreSheetTabs(){
  return TABS.filter(t => !MOBILE_BOTTOM_TABS.includes(t.key));
}

function renderMoreSheet(){
  const body = document.getElementById('more-sheet-body');
  if (!body) return;
  const rows = _moreSheetTabs().map(t => {
    const chip = PHASE_2_TABS.has(t.key) ? '<span class="phase-chip-mini">P2</span>' : '';
    return '<button class="btn more-sheet-row" data-click="navigate" data-a0="' + t.key + '">'
      + t.icon + '<span>' + kjrEscape(t.label) + '</span>' + chip + '</button>';
  }).join('');
  const crossApp = ''
    + '<a class="btn more-sheet-row" href="../Trading/" style="text-decoration:none">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l6-6 4 4 8-8"/></svg><span>Trading</span></a>'
    + '<a class="btn more-sheet-row" href="../Journal/" style="text-decoration:none">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg><span>Journal</span></a>';
  body.innerHTML = rows + crossApp;
}

function openMoreSheet(){
  const ov = document.getElementById('more-sheet');
  if (!ov) return;
  renderMoreSheet();
  ov.classList.add('open');
  // The sheet starts translated off-screen (CSS default) and slides in via
  // .sheet-in, added a frame after .open so display:none -> flex doesn't eat
  // the transition (no transition fires across a display change in the same frame).
  requestAnimationFrame(() => ov.classList.add('sheet-in'));
  document.querySelectorAll('.bottom-tab-bar .nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === 'more');
  });
}

function closeMoreSheet(){
  const ov = document.getElementById('more-sheet');
  if (ov){ ov.classList.remove('open'); ov.classList.remove('sheet-in'); }
  // Opening the sheet gave "More" the active state as tap feedback. If the
  // user dismissed without navigating, hand the highlight back to the tab
  // that actually owns the page. (showPage also calls this before its own
  // active-state pass, which lands the same result, so there is no flicker.)
  const cur = (typeof _currentTab !== 'undefined' && _currentTab) ? _currentTab : 'dashboard';
  const inMoreSheet = !MOBILE_BOTTOM_TABS.includes(cur);
  document.querySelectorAll('.bottom-tab-bar .nav-btn').forEach(b => {
    if (b.dataset.tab === 'more') b.classList.toggle('active', inMoreSheet);
    else b.classList.toggle('active', b.dataset.tab === cur);
  });
}

function showPage(key){
  const prev = _currentTab;
  _currentTab = key;
  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('active');
    p.classList.remove('phase2-locked');
  });
  const target = document.getElementById('page-' + key);
  if (target) {
    target.classList.add('active');
    if (PHASE_2_TABS.has(key)) {
      ensurePhase2Card(target, key);
      target.classList.add('phase2-locked');
    }
  }
  // On mobile the current tab may live only in the More sheet (not one of the
  // 5 fixed bottom-bar buttons); the "more" button then takes the active state.
  const inMoreSheet = !MOBILE_BOTTOM_TABS.includes(key);
  document.querySelectorAll('.nav-btn').forEach(b => {
    if (b.dataset.tab === 'more') { b.classList.toggle('active', inMoreSheet); return; }
    b.classList.toggle('active', b.dataset.tab === key);
  });
  closeMoreSheet(); // navigating (incl. from within the sheet) always closes it
  updateCcyToggleUI(); // reflect the new tab's currency
  if (key === 'dashboard') renderDashboard(); // (re)draw charts now the canvas is sized
  if (key === 'settings') { loadSettingsForm(); renderDiagnostics(); }
  if (window.scrollTo) window.scrollTo({ top: 0, behavior: 'instant' });
  // History is owned by the router (navigate/hashchange), not showPage — see
  // the router block above. showPage is now a pure render primitive.
}

/* ═══════════════════════════════════════════════════════════════════════
   THEME
   ═══════════════════════════════════════════════════════════════════════ */
function currentTheme(){
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}
function applyTheme(t){
  document.documentElement.classList.toggle('dark', t === 'dark');
  updateThemeUI(t);
  // iOS Safari + installed-app chrome paint from this meta tag. Read the
  // actual --bg the class toggle just applied rather than hardcoding the two
  // hex values here as well, so the two can never drift apart.
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) themeMeta.setAttribute('content', bg);
  }
  // Charts read colours from CSS vars at draw time, so redraw if the dashboard is up.
  if (typeof _currentTab !== 'undefined' && _currentTab === 'dashboard' && typeof renderDashboard === 'function') {
    renderDashboard();
  }
}
function setThemeChoice(t){
  t = (t === 'dark') ? 'dark' : 'light';
  localStorage.setItem(LK_THEME, t);
  applyTheme(t);
}
function toggleTheme(){
  setThemeChoice(currentTheme() === 'dark' ? 'light' : 'dark');
}

/* ═══════════════════════════════════════════════════════════════════════
   PRIVACY MODE — blur every money figure so an onlooker cannot read the
   net worth or balances off the screen. Pure CSS (html.privacy + selectors),
   so it survives re-renders. State persists in localStorage, per-device.
   ═══════════════════════════════════════════════════════════════════════ */
const EYE_SVG     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
function privacyOn(){ return localStorage.getItem(LK_PRIVACY) === '1'; }
function applyPrivacy(on){
  document.documentElement.classList.toggle('privacy', !!on);
  const btn = document.getElementById('privacy-toggle');
  if (btn){
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Show amounts' : 'Hide amounts';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = on ? EYE_OFF_SVG : EYE_SVG;
  }
}
function togglePrivacy(){
  const on = !privacyOn();
  localStorage.setItem(LK_PRIVACY, on ? '1' : '0');
  applyPrivacy(on);
  showToast(on ? 'Amounts hidden' : 'Amounts shown');
}
function updateThemeUI(t){
  t = t || currentTheme();
  document.querySelectorAll('.theme-toggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === t);
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   COIN LOOKUP — symbol → CoinGecko id, for the most common coins.
   User can override per-entry; this is just a convenience.
   ═══════════════════════════════════════════════════════════════════════ */
const COIN_LOOKUP = {
  BTC:'bitcoin', ETH:'ethereum', USDT:'tether', USDC:'usd-coin', BNB:'binancecoin',
  SOL:'solana', XRP:'ripple', ADA:'cardano', DOGE:'dogecoin', TRX:'tron',
  TON:'the-open-network', AVAX:'avalanche-2', DOT:'polkadot', MATIC:'matic-network',
  LINK:'chainlink', LTC:'litecoin', BCH:'bitcoin-cash', SHIB:'shiba-inu',
  UNI:'uniswap', DAI:'dai', WBTC:'wrapped-bitcoin', ICP:'internet-computer',
  XLM:'stellar', ATOM:'cosmos', XMR:'monero', APT:'aptos', NEAR:'near',
  ARB:'arbitrum', OP:'optimism', AAVE:'aave', FIL:'filecoin', ETC:'ethereum-classic',
  MKR:'maker', VET:'vechain', ALGO:'algorand', HBAR:'hedera-hashgraph',
  GRT:'the-graph', SUI:'sui', INJ:'injective-protocol', PEPE:'pepe',
  RUNE:'thorchain', IMX:'immutable-x', TAO:'bittensor', RNDR:'render-token',
  KAS:'kaspa', FTM:'fantom', WLD:'worldcoin-wld'
};
function coinIdFor(symbolOrId){
  if (!symbolOrId) return null;
  const v = String(symbolOrId).trim();
  if (!v) return null;
  if (COIN_LOOKUP[v.toUpperCase()]) return COIN_LOOKUP[v.toUpperCase()];
  return v.toLowerCase(); // assume user entered the CoinGecko id directly
}

/* ═══════════════════════════════════════════════════════════════════════
   FX — convert anything to base currency (SGD by default)
   ═══════════════════════════════════════════════════════════════════════ */
/* Any-currency-to-SGD rate is looked up under fxRates[<CCY>SGD] (the existing
   'USDSGD' key is just the CCY=USD case, unchanged for back-compat). A cross
   pair (X to Y, neither SGD) routes through SGD: XSGD / YSGD. Returns null,
   never a guess, when a needed leg is missing so callers can decide whether
   to fall back or exclude. */
function getFx(from, to){
  from = (from || '').toUpperCase();
  to   = (to   || '').toUpperCase();
  if (!from || !to || from === to) return 1;

  // Manual override, USD/SGD only, wins over any fetched rate.
  if (from === 'USD' && to === 'SGD' && DB.settings.fxOverrides.USDSGD)
    return Number(DB.settings.fxOverrides.USDSGD);
  if (from === 'SGD' && to === 'USD' && DB.settings.fxOverrides.USDSGD)
    return 1 / Number(DB.settings.fxOverrides.USDSGD);

  const rates = DB.settings.fxRates || {};
  const rateToSgd = (ccy) => {
    const r = rates[ccy + 'SGD'];
    return (r != null && isFinite(Number(r)) && Number(r) > 0) ? Number(r) : null;
  };

  if (to === 'SGD') return rateToSgd(from);
  if (from === 'SGD'){
    const r = rateToSgd(to);
    return r != null ? 1 / r : null;
  }
  // Cross pair: both legs must be known.
  const fromSgd = rateToSgd(from), toSgd = rateToSgd(to);
  if (fromSgd == null || toSgd == null) return null;
  return fromSgd / toSgd;
}

function toSGD(amount, currency){
  const n = Number(amount);
  if (!isFinite(n)) return 0;
  if (!currency || currency === 'SGD') return n;
  const r = getFx(currency, 'SGD');
  if (r == null) return n; // best-effort; UI flags missing FX
  return n * r;
}

/* Strict SGD conversion for aggregate totals (net worth, snapshots, expense
   roll-ups): returns null instead of silently passing the raw number through
   1:1 when the rate is missing, so a caller summing many accounts/rows can
   exclude the unconvertible ones rather than let a foreign-currency figure
   inflate an SGD total at face value. */
function sgdOrNull(amount, currency){
  const ccy = currency || 'SGD';
  const n = Number(amount);
  if (!isFinite(n)) return 0;
  if (ccy === 'SGD') return n;
  const r = getFx(ccy, 'SGD');
  return r == null ? null : n * r;
}

/* ─── Per-tab display currency ─────────────────────────────────────────
   Each tab shows values in its own currency: Stocks defaults to USD (most
   holdings are US-priced), everything else defaults to SGD (CPF, salary,
   property are SGD by nature). The header toggle controls the active tab's
   currency and stores a per-tab override.

   `_renderCcy` is the currency for the render pass in flight. Every render
   function sets it via setRenderCcy() at its top, so fmt() converts to the
   right currency even when renderAll() paints every tab in one go. */
let _currentTab       = 'stocks';
let _dashShowCpf      = false; // default off on every launch — user toggles to include CPF
let _navigatingHistory = false; // true while popstate fires, stops showPage re-pushing
let _renderCcy        = 'SGD';

function tabDefaultCcy(tab){ return tab === 'stocks' ? 'USD' : (DB.settings.baseCurrency || 'SGD'); }
function tabDisplayCcy(tab){
  const o = DB.settings.tabCurrency || {};
  return o[tab] || tabDefaultCcy(tab);
}
function setRenderCcy(tab){ _renderCcy = tabDisplayCcy(tab); }

/* Active render currency — what fmt() and the dynamic labels convert to. */
function displayCcy(){ return _renderCcy; }

/* Convert a native amount into the active render currency. */
function toDisplay(amount, currency){
  const n = Number(amount);
  if (!isFinite(n)) return 0;
  const to = displayCcy();
  const from = currency || 'SGD';
  if (from === to) return n;
  const r = getFx(from, to);
  if (r == null) return n; // best-effort; UI flags missing FX
  return n * r;
}

/* True when converting `currency` to the active render currency is not
   possible (no FX rate). Drives the "FX missing" hints. */
function fxMissingFor(currency){
  const from = currency || 'SGD';
  if (from === displayCcy()) return false;
  return getFx(from, displayCcy()) == null;
}

/* Header toggle writes a per-tab override for whichever tab is showing. */
function setDisplayCcy(ccy){
  if (ccy !== 'SGD' && ccy !== 'USD') return;
  if (!DB.settings.tabCurrency) DB.settings.tabCurrency = {};
  DB.settings.tabCurrency[_currentTab] = ccy;
  saveData();
  renderAll();
  updateCcyToggleUI();
}

function updateCcyToggleUI(){
  const cur = tabDisplayCcy(_currentTab);
  document.querySelectorAll('.ccy-toggle [data-ccy]').forEach(b => {
    b.classList.toggle('active', b.dataset.ccy === cur);
  });
}

/* opts.silent suppresses the success toast (auto-refresh path). Failures
   still toast only on the manual path. A single in-flight guard collapses
   the auto-tick + refreshStockPrices double-call into one network hit. */
/* Every non-SGD currency actually in use, so a JPY cash account or an EUR
   expense gets its own rate fetched instead of only ever asking for USDSGD.
   USD is always included (stocks/crypto lean on it even with no USD cash). */
function _fxPairsInUse(){
  const ccys = new Set(['USD']);
  (DB.cash || []).forEach(c => { const ccy = (c.currency || 'SGD').toUpperCase(); if (ccy !== 'SGD') ccys.add(ccy); });
  (DB.expenses || []).forEach(x => { const ccy = (x.currency || 'SGD').toUpperCase(); if (ccy !== 'SGD') ccys.add(ccy); });
  return Array.from(ccys).map(c => c + 'SGD');
}

let _fxInFlight = null;
async function refreshFx(opts){
  opts = opts || {};
  if (_fxInFlight) return _fxInFlight;          // dedupe concurrent calls
  if (!getSyncUrl()) { if (!opts.silent) showToast('Set the Apps Script URL first', 'error'); return; }
  const btn = document.getElementById('btn-refresh-fx');
  if (btn) btn.disabled = true;
  _fxInFlight = (async () => {
    try {
      const pairs = _fxPairsInUse();
      const url = getSyncUrl() + (getSyncUrl().includes('?') ? '&' : '?') + 'action=fx&pairs=' + encodeURIComponent(pairs.join(','));
      const resp = await fetch(url, { method:'GET', mode:'cors', redirect:'follow' });
      const data = await resp.json();
      if (data.error && !data.rates) throw new Error(data.error);
      const rates = data.rates || {};
      let ok = 0;
      pairs.forEach(p => {
        const rate = rates[p] && rates[p].rate;
        if (rate != null && isFinite(Number(rate))){ DB.settings.fxRates[p] = Number(rate); ok++; }
      });
      if (!ok) throw new Error('No rates in response');
      DB.settings.fxRates.lastUpdated = new Date().toISOString();
      saveData();
      renderAll();
      if (!opts.silent) showToast('FX refreshed: ' + ok + '/' + pairs.length + ' pair' + (pairs.length===1?'':'s'), 'success');
    } catch (err) {
      if (!opts.silent) showToast('FX refresh failed: ' + err.message, 'error');
      else console.warn('[fx]', err.message);
    } finally {
      if (btn) btn.disabled = false;
      _fxInFlight = null;
    }
  })();
  return _fxInFlight;
}

function fxFreshnessText(){
  const ts = DB.settings.fxRates.lastUpdated;
  if (!ts) return DB.settings.fxOverrides.USDSGD ? 'Manual override' : 'No FX yet';
  return 'FX ' + relTime(ts);
}

/* ═══════════════════════════════════════════════════════════════════════
   AUTO-REFRESH — poll prices on a timer, only when useful
   - Tab visible (Page Visibility API)
   - Backend configured
   - User hasn't disabled the toggle in Settings
   - Stocks/FX: Mon-Fri SGT only (covers SGX local hours + US pre/regular/post)
   - Crypto: every tick, 24/7
   - One in-flight refresh at a time per resource (guards inside refresh fns)
   - Pauses when tab hidden, resumes on focus
   ═══════════════════════════════════════════════════════════════════════ */
let _autoRefreshTimer = null;
let _autoTickInFlight = false;
let _stockRefreshInFlight = false;   // dedupe manual click vs auto-tick price pulls
let _cryptoRefreshInFlight = false;

/* ── Undo / Redo ─────────────────────────────────────────────────────────
   Snapshots of DB taken before each user-initiated mutation (modal save,
   delete). Auto-refresh price updates are intentionally excluded — you
   can't "undo" a market price. Stack capped at 20 to bound memory. */
const UNDO_MAX = 20;
let _undoStack = [], _redoStack = [];
function pushUndo(){
  _undoStack.push(JSON.stringify(DB));
  if (_undoStack.length > UNDO_MAX) _undoStack.shift();
  _redoStack = [];
}
function undoAction(){
  if (!_undoStack.length){ showToast('Nothing to undo'); return; }
  _redoStack.push(JSON.stringify(DB));
  DB = JSON.parse(_undoStack.pop());
  saveData(); renderAll(); showToast('Undone', 'success');
}
function redoAction(){
  if (!_redoStack.length){ showToast('Nothing to redo'); return; }
  _undoStack.push(JSON.stringify(DB));
  DB = JSON.parse(_redoStack.pop());
  saveData(); renderAll(); showToast('Redone', 'success');
}

function autoRefreshEnabled(){
  // Default ON. User can disable via Settings → "Auto-refresh prices" toggle.
  return localStorage.getItem(LK_AUTO_REFRESH) !== '0';
}

function setAutoRefreshEnabled(on){
  localStorage.setItem(LK_AUTO_REFRESH, on ? '1' : '0');
  if (on) startAutoRefresh(); else stopAutoRefresh();
}

/* Is it Mon-Fri in Singapore time? Used to gate stock/FX refresh.
   We use SGT because SGX is local, and US market hours converted to SGT
   land on the same weekday (US Friday afternoon = SGT Saturday morning,
   which is outside any meaningful window for retail). */
function isStockMarketDaySGT(){
  try {
    const wd = new Intl.DateTimeFormat('en-SG', {
      timeZone: 'Asia/Singapore', weekday: 'short'
    }).format(new Date());
    return wd !== 'Sat' && wd !== 'Sun';
  } catch (_) {
    // Fallback to local time if Intl fails
    const d = new Date().getDay();
    return d >= 1 && d <= 5;
  }
}

async function autoRefreshTick(){
  if (!autoRefreshEnabled()) return;
  if (document.hidden) return;
  if (!getSyncUrl()) return;
  if (_autoTickInFlight) return;
  _autoTickInFlight = true;
  try {
    const promises = [];
    if ((DB.crypto || []).length) {
      promises.push(refreshCryptoPrices().catch(err => console.warn('[auto] crypto', err.message)));
    }
    if (isStockMarketDaySGT()) {
      if ((DB.stocks || []).length) {
        promises.push(refreshStockPrices({ silent: true }).catch(err => console.warn('[auto] stocks', err.message)));
      }
      // FX refresh only if we have any non-SGD position (cash, stocks priced USD, etc.)
      const needFx = (DB.stocks || []).some(s => (s.currency || (s.market === 'US' ? 'USD' : 'SGD')) !== 'SGD')
                  || (DB.cash   || []).some(c => (c.currency || 'SGD') !== 'SGD')
                  || (DB.crypto || []).some(c => (c.currency || 'USD') !== 'SGD');
      if (needFx && !DB.settings.fxOverrides.USDSGD) {
        promises.push(refreshFx({ silent: true }).catch(err => console.warn('[auto] fx', err.message)));
      }
    }
    await Promise.allSettled(promises);
  } finally {
    _autoTickInFlight = false;
  }
}

function startAutoRefresh(){
  stopAutoRefresh();
  if (!autoRefreshEnabled()) return;
  // Tick immediately, then on interval. Don't await — let it run async.
  autoRefreshTick();
  _autoRefreshTimer = setInterval(autoRefreshTick, AUTO_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh(){
  if (_autoRefreshTimer) { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null; }
}

/* Visibility handler: pause when tab hidden, run a fresh tick when it
   becomes visible. Page Visibility API is universally supported. */
function installAutoRefreshVisibility(){
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopAutoRefresh();
    } else {
      startAutoRefresh();
    }
  });
  // Browsers also fire 'focus' when window regains focus from another window
  window.addEventListener('focus', () => {
    if (!document.hidden) autoRefreshTick();
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   PRICE FETCH — Yahoo for stocks/FX, CoinGecko for crypto
   ═══════════════════════════════════════════════════════════════════════ */
function yahooSymbol(stock){
  const s = (stock.symbol || '').trim().toUpperCase();
  if (!s) return '';
  if (s.includes('.')) return s; // user already supplied exchange suffix
  if (stock.market === 'SGX') return s + '.SI';
  return s;
}

function isStale(fetchedAt, hours){
  if (!fetchedAt) return true;
  const t = new Date(fetchedAt).getTime();
  if (!isFinite(t)) return true;
  return (Date.now() - t) > (hours || 24) * 3600 * 1000;
}

function priceFreshnessText(table){
  const items = DB[table] || [];
  if (!items.length) return 'No holdings yet';
  let oldest = null;
  for (const it of items){
    const px = priceFor(table, it);
    if (px && px.fetchedAt) {
      const t = new Date(px.fetchedAt).getTime();
      if (oldest == null || t < oldest) oldest = t;
    }
  }
  return oldest ? 'Prices ' + relTime(new Date(oldest)) : 'No prices yet';
}

function priceFor(table, item){
  if (table === 'stocks' || table === 'watchlist') return DB._priceCache[yahooSymbol(item)] || null;
  if (table === 'crypto') return DB._priceCache[coinIdFor(item.coingeckoId || item.symbol)] || null;
  return null;
}

async function refreshStockPrices(opts = {}){
  if (!DB.stocks.length && !(DB.watchlist || []).length){ if (!opts.silent) showToast('No stocks to refresh'); return; }
  if (!getSyncUrl()){ if (!opts.silent) showToast('Set the Apps Script URL first', 'error'); return; }
  if (_stockRefreshInFlight){ if (!opts.silent) showToast('Price refresh already running'); return; }
  _stockRefreshInFlight = true;
  const btn = document.getElementById('btn-refresh-stocks');
  if (btn) btn.disabled = true;
  try {
    const symbols = Array.from(new Set(
      DB.stocks.map(yahooSymbol).concat((DB.watchlist || []).map(yahooSymbol)).filter(Boolean)
    ));
    if (!symbols.length){ showToast('No valid symbols', 'error'); return; }
    const url = getSyncUrl() + (getSyncUrl().includes('?') ? '&' : '?') +
                'action=prices&symbols=' + encodeURIComponent(symbols.join(','));
    const resp = await fetch(url, { method:'GET', mode:'cors', redirect:'follow' });
    const data = await resp.json();
    if (data.error && !data.quotes) throw new Error(data.error);
    let ok = 0, fail = 0;
    Object.entries(data.quotes || {}).forEach(([sym, q]) => {
      if (q.error){ fail++; return; }
      DB._priceCache[sym] = q;
      ok++;
    });
    // Auto-refresh FX too if we have any USD-denominated positions
    if (DB.stocks.some(s => (s.currency || (s.market === 'US' ? 'USD' : 'SGD')) === 'USD') && !DB.settings.fxOverrides.USDSGD){
      refreshFx({ silent: true }).catch(()=>{});
    }
    saveData();
    renderStocks();
    if (!opts.silent) showToast('Prices: ' + ok + ' refreshed' + (fail ? ', ' + fail + ' failed' : ''), fail ? 'error' : 'success');
    // Fundamentals ride behind the price refresh, fire-and-forget: the cells
    // fill in when they land, and a miss leaves the '—' tokens (non-fatal).
    refreshFundamentals(symbols);
  } catch (err) {
    showToast('Price refresh failed: ' + err.message, 'error');
  } finally {
    _stockRefreshInFlight = false;
    if (btn) btn.disabled = false;
  }
}

/* Fundamentals (PE, PB, beta, payout, 200d MA …) from the quoteSummary proxy.
   Slow-moving stats: the server caches them 6 h, so this is cheap to call on
   every price refresh. Stored under _priceCache[sym].fund — memory-only, same
   as quotes. Success is silent (the columns visibly populate); only a total
   wipe-out gets a toast, since that usually means Yahoo's crumb gate. */
async function refreshFundamentals(symbols){
  try {
    const url = getSyncUrl() + (getSyncUrl().includes('?') ? '&' : '?') +
                'action=fundamentals&symbols=' + encodeURIComponent(symbols.join(','));
    const resp = await fetch(url, { method:'GET', mode:'cors', redirect:'follow' });
    const data = await resp.json();
    if (data.error && !data.fundamentals) throw new Error(data.error);
    let ok = 0;
    Object.entries(data.fundamentals || {}).forEach(([sym, f]) => {
      if (!f || f.error) return;
      if (!DB._priceCache[sym]) DB._priceCache[sym] = { symbol: sym };
      DB._priceCache[sym].fund = f;
      ok++;
    });
    if (ok){ renderStocks(); }
  } catch (_) { /* nice-to-have columns; quotes and money maths are unaffected */ }
}

async function refreshCryptoPrices(){
  if (!DB.crypto.length){ showToast('No coins to refresh'); return; }
  if (!getSyncUrl()){ showToast('Set the Apps Script URL first', 'error'); return; }
  if (_cryptoRefreshInFlight){ showToast('Crypto refresh already running'); return; }
  _cryptoRefreshInFlight = true;
  const btn = document.getElementById('btn-refresh-crypto');
  if (btn) btn.disabled = true;
  try {
    const ids = Array.from(new Set(DB.crypto.map(c => coinIdFor(c.coingeckoId || c.symbol)).filter(Boolean)));
    if (!ids.length){ showToast('No valid coin ids', 'error'); return; }
    const url = getSyncUrl() + (getSyncUrl().includes('?') ? '&' : '?') +
                'action=crypto&ids=' + encodeURIComponent(ids.join(',')) + '&vs=sgd,usd';
    const resp = await fetch(url, { method:'GET', mode:'cors', redirect:'follow' });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    const stamp = data.fetchedAt || new Date().toISOString();
    let ok = 0;
    Object.entries(data.prices || {}).forEach(([id, p]) => {
      DB._priceCache[id] = {
        sgd: p.sgd, usd: p.usd, change24h: p.sgd_24h_change || p.usd_24h_change,
        fetchedAt: stamp, source: 'coingecko'
      };
      ok++;
    });
    saveData();
    renderCrypto();
    showToast('Crypto: ' + ok + ' refreshed', 'success');
  } catch (err) {
    showToast('Crypto refresh failed: ' + err.message, 'error');
  } finally {
    _cryptoRefreshInFlight = false;
    if (btn) btn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   SOFT DELETE — Kujira convention: never hard-delete, push to trash.
   Trash UI ("Recently deleted") lives in Settings: restore, purge, empty.
   ═══════════════════════════════════════════════════════════════════════ */
const TRASH_MAX = 100; // bound the synced payload; oldest deletions drop first
function sendToTrash(table, id){
  if (!DB[table]) return false;
  const idx = DB[table].findIndex(x => x.id === id);
  if (idx < 0) return false;
  const item = DB[table][idx];
  DB[table].splice(idx, 1);
  if (!DB.trash) DB.trash = [];
  DB.trash.push({ id: uid('tr'), table, ts: new Date().toISOString(), data: item });
  if (DB.trash.length > TRASH_MAX) DB.trash = DB.trash.slice(-TRASH_MAX);
  saveData();
  return true;
}

/* Human label for a trashed entry, by table. Used by the Recently deleted UI. */
const TRASH_TABLE_NAMES = { stocks:'Stock', stockTxns:'Trade', watchlist:'Watchlist', crypto:'Crypto', realestate:'Property', cash:'Cash account', cashTxns:'Cash movement', cpfHistory:'CPF entry', income:'Income', expenses:'Expense' };
function trashLabel(table, data){
  data = data || {};
  const d = data.date ? (' · ' + fmtDateSG(data.date)) : '';
  switch (table){
    case 'stocks':     return (data.symbol || '?') + (data.market ? ' · ' + data.market : '');
    case 'watchlist':  return (data.symbol || '?');
    case 'crypto':     return (data.symbol || '?');
    case 'realestate': return data.name || 'property';
    case 'cash':       return (data.name || 'account') + ' · ' + (data.currency || 'SGD');
    case 'stockTxns': {
      const sym = ((DB.stocks||[]).find(s => s.id === data.stockId) || {}).symbol || '?';
      return (data.side === 'sell' ? 'Sell ' : 'Buy ') + (Math.abs(Number(data.shares)||0)) + ' ' + sym + d;
    }
    case 'cashTxns':   return (data.type || 'movement') + ' ' + (Number(data.amount)||0) + d;
    case 'cpfHistory': return (data.type || 'entry') + ' ' + (data.account || '') + ' ' + (Number(data.amount)||0) + d;
    case 'income':     return 'Gross ' + (Number(data.gross)||0) + d;
    case 'expenses':   return (data.category || 'expense') + ' ' + (Number(data.amount)||0) + d;
    default:           return table;
  }
}

/* Render the Recently deleted list (Settings). Newest first. */
function renderTrash(){
  const host = document.getElementById('trash-list');
  if (!host) return;
  const trash = (DB.trash || []).slice().sort((a,b) => String(b.ts||'').localeCompare(String(a.ts||'')));
  const meta  = document.getElementById('trash-meta');
  if (meta) meta.textContent = trash.length ? (trash.length + ' item' + (trash.length > 1 ? 's' : '')) : '';
  const emptyBtn = document.getElementById('trash-empty-btn');
  if (emptyBtn) emptyBtn.style.display = trash.length ? '' : 'none';
  if (!trash.length){
    host.innerHTML = '<div class="hint">Nothing here. Deleted entries land here so you can restore them.</div>';
    return;
  }
  host.innerHTML = trash.map(e => `
    <div class="trash-row">
      <div class="trash-info">
        <span class="tag">${kjrEscape(TRASH_TABLE_NAMES[e.table] || e.table)}</span>
        <span class="trash-label">${kjrEscape(trashLabel(e.table, e.data))}</span>
        <span class="hint">deleted ${kjrEscape(relTime(e.ts))}</span>
      </div>
      <div class="trash-actions">
        <button class="btn btn-sm" data-click="restoreFromTrash" data-a0="${kjrEscape(e.id)}">Restore</button>
        <button class="btn btn-sm btn-danger" data-click="purgeTrashItem" data-a0="${kjrEscape(e.id)}" title="Delete permanently">✕</button>
      </div>
    </div>`).join('');
}

/* Put a trashed entry back into its table. Restores its contribution to all
   derived totals (balances, P&L). Regenerates the id only if it would collide. */
function restoreFromTrash(trashId){
  const trash = DB.trash || [];
  const idx = trash.findIndex(e => e.id === trashId);
  if (idx < 0) return;
  const entry = trash[idx];
  if (!ENTITY_SCHEMAS[entry.table] && !_LIST_TABLES.includes(entry.table)){
    showToast('Cannot restore this entry', 'error'); return;
  }
  pushUndo();
  const item = Object.assign({}, entry.data);
  if (!kjrSafeId(item.id)) item.id = uid(entry.table);
  if (!DB[entry.table]) DB[entry.table] = [];
  if (DB[entry.table].some(x => x.id === item.id)) item.id = uid(entry.table);
  item.updatedAt = new Date().toISOString();
  DB[entry.table].push(item);
  trash.splice(idx, 1);
  saveData();
  renderAll();
  renderTrash();
  showToast('Restored', 'success');
}

/* Permanently remove one trashed entry. */
function purgeTrashItem(trashId){
  const trash = DB.trash || [];
  const idx = trash.findIndex(e => e.id === trashId);
  if (idx < 0) return;
  if (!confirm('Permanently delete this entry? This cannot be undone.')) return;
  pushUndo();
  trash.splice(idx, 1);
  saveData();
  renderTrash();
  showToast('Deleted permanently', 'success');
}

/* Empty the whole Recently deleted list. */
function emptyTrash(){
  const n = (DB.trash || []).length;
  if (!n) return;
  if (!confirm('Permanently delete all ' + n + ' item' + (n > 1 ? 's' : '') + ' in Recently deleted? This cannot be undone.')) return;
  pushUndo();
  DB.trash = [];
  saveData();
  renderTrash();
  showToast('Recently deleted emptied', 'success');
}

/* ═══════════════════════════════════════════════════════════════════════
   ENTITY MODAL — shared CRUD form for the four holdings tables
   ═══════════════════════════════════════════════════════════════════════ */
let _modalState  = null; // { table, item, isNew }
let _modalOpener = null; // element focused before modal opened (restored on close)
let _modalKeyTrap = null; // keydown handler reference so we can remove it cleanly

/* GICS 11 sectors + two app-level labels. Values feed sectorClass() in
   kjr-core.js, which buckets them cyclical / defensive / sensitive for the
   allocation view. Keep the strings in sync with SECTOR_CLASS there. */
const GICS_SECTOR_OPTIONS = [
  ['', '— Untagged —'],
  ['Communication Services','Communication Services'],
  ['Consumer Discretionary','Consumer Discretionary'],
  ['Consumer Staples','Consumer Staples'],
  ['Energy','Energy'],
  ['Financials','Financials'],
  ['Healthcare','Healthcare'],
  ['Industrials','Industrials'],
  ['Information Technology','Information Technology'],
  ['Materials','Materials'],
  ['Real Estate','Real Estate'],
  ['Utilities','Utilities'],
  ['ETF / Fund','ETF / Fund'],
  ['Other','Other']
];

// Yahoo assetProfile uses Morningstar-style names; map to the app's GICS values.
const YAHOO_SECTOR_TO_GICS = {
  'Technology':             'Information Technology',
  'Financial Services':     'Financials',
  'Consumer Cyclical':      'Consumer Discretionary',
  'Consumer Defensive':     'Consumer Staples',
  'Basic Materials':        'Materials',
  'Communication Services': 'Communication Services',
  'Energy':                 'Energy',
  'Healthcare':             'Healthcare',
  'Industrials':            'Industrials',
  'Real Estate':            'Real Estate',
  'Utilities':              'Utilities'
};

const ENTITY_SCHEMAS = {
  stocks: {
    title: 'stock holding',
    fields: [
      { key:'symbol',  label:'Symbol',  type:'text',   required:true, placeholder:'AAPL or D05', hint:'Yahoo ticker. For SGX, omit the .SI (we add it).' },
      { key:'market',  label:'Market',  type:'select', required:true, options:[['SGX','SGX (Singapore)'],['US','US (NYSE/NASDAQ)']], default:'US' },
      { key:'sector',  label:'Sector',  type:'select', options:GICS_SECTOR_OPTIONS, default:'', hint:'Optional. Drives the sector allocation view and the cyclical/defensive split.' },
      { key:'shares',  label:'Shares',  type:'number', required:true, step:'0.0001', min:'0', placeholder:'100', hint:'Your current holding. If you log trades below, this is treated as the opening position and trades adjust it.' },
      { key:'avgCost', label:'Avg cost per share', type:'number', required:true, step:'0.0001', min:'0', placeholder:'150.00' },
      { key:'currency', label:'Cost currency', type:'select', options:[['USD','USD'],['SGD','SGD']], default:'USD', hint:'Currency the avg cost is stated in. Defaults match the market.' },
      { key:'divPerShare', label:'Annual dividend / share', type:'number', step:'0.0001', min:'0', placeholder:'0.00', hint:'Optional, in the cost currency. Drives projected dividend income and yield on cost. Leave blank for non-payers.' },
      { key:'divExDate',  label:'Ex-dividend date', type:'date', hint:'Next ex-dividend date. Drives the upcoming payments list (next 90 days).' },
      { key:'divPayDate', label:'Pay date', type:'date', hint:'Expected payment date (optional).' },
      { key:'notes',   label:'Notes', type:'textarea' }
    ],
    defaults: { market:'US', currency:'USD' },
    afterRead: (item) => {
      // Coerce currency when market changes if user hasn't set one
      if (!item.currency) item.currency = item.market === 'SGX' ? 'SGD' : 'USD';
      item.symbol = (item.symbol || '').trim().toUpperCase();
      // Dividends cannot be negative; clamp bad input to "no dividend".
      if (item.divPerShare != null && Number(item.divPerShare) < 0) item.divPerShare = null;
    }
  },
  stockTxns: {
    title: 'trade',
    fields: [
      { key:'stockId', label:'Stock', type:'select', required:true,
        optionsFn: () => (DB.stocks || []).map(s => [s.id, (s.symbol || '?') + ' · ' + (s.market || '')]),
        hint:'Add the stock under positions first.' },
      { key:'date',    label:'Trade date', type:'date', required:true },
      { key:'side',    label:'Side', type:'select', required:true, options:[['buy','Buy'],['sell','Sell']], default:'buy' },
      { key:'shares',  label:'Shares', type:'number', required:true, step:'0.0001', placeholder:'10' },
      { key:'price',   label:'Price per share', type:'number', required:true, step:'0.0001', min:'0', placeholder:'150.00', hint:'In the stock\'s own currency.' },
      { key:'fees',    label:'Fees / commission', type:'number', step:'0.01', min:'0', placeholder:'0.00' },
      { key:'cashAccountId', label:'Funded from (cash account)', type:'select',
        optionsFn: () => [['', '— Not linked —']].concat((DB.cash || []).map(c => [c.id, (c.name || '?') + ' · ' + (c.currency || 'SGD')])),
        hint:'Buys debit this account, sells credit it. Use a same-currency account.' },
      { key:'notes',   label:'Notes', type:'textarea' }
    ],
    defaults: { date: new Date().toISOString().slice(0,10), side:'buy', fees:0, cashAccountId:'' }
  },
  watchlist: {
    title: 'watchlist ticker',
    fields: [
      { key:'symbol', label:'Symbol', type:'text', required:true, placeholder:'NVDA or U11', hint:'Yahoo ticker. For SGX, omit the .SI (we add it).' },
      { key:'market', label:'Market', type:'select', required:true, options:[['SGX','SGX (Singapore)'],['US','US (NYSE/NASDAQ)']], default:'US' },
      { key:'sector', label:'Sector', type:'select', options:GICS_SECTOR_OPTIONS, default:'' },
      { key:'targetPrice', label:'Target buy price', type:'number', step:'0.0001', min:'0', placeholder:'0.00', hint:'Optional, in the ticker\'s own trading currency. The row flags when price reaches it.' },
      { key:'notes',  label:'Notes', type:'textarea' }
    ],
    defaults: { market:'US' },
    afterRead: (item) => {
      item.symbol = (item.symbol || '').trim().toUpperCase();
      if (item.targetPrice != null && Number(item.targetPrice) <= 0) item.targetPrice = null;
    }
  },
  crypto: {
    title: 'crypto holding',
    fields: [
      { key:'symbol',       label:'Symbol', type:'text', required:true, placeholder:'BTC', hint:'Common ticker. Mapped to CoinGecko id automatically for known coins.' },
      { key:'coingeckoId',  label:'CoinGecko ID (override)', type:'text', placeholder:'bitcoin', hint:'Leave blank if symbol is in the common list.' },
      { key:'amount',       label:'Amount', type:'number', required:true, step:'0.00000001', min:'0', placeholder:'0.5' },
      { key:'avgCost',      label:'Avg cost per coin', type:'number', step:'0.0001', min:'0', placeholder:'45000' },
      { key:'currency',     label:'Cost currency', type:'select', options:[['USD','USD'],['SGD','SGD']], default:'USD' },
      { key:'notes',        label:'Notes', type:'textarea' }
    ],
    defaults: { currency:'USD' },
    afterRead: (item) => {
      item.symbol = (item.symbol || '').trim().toUpperCase();
      if (item.coingeckoId) item.coingeckoId = item.coingeckoId.trim().toLowerCase();
    }
  },
  realestate: {
    title: 'property',
    fields: [
      { key:'name',     label:'Name / address', type:'text', required:true, placeholder:'HDB, Punggol' },
      { key:'value',    label:'Current value (SGD)', type:'number', required:true, step:'1', min:'0', placeholder:'500000' },
      { key:'notes',    label:'Notes', type:'textarea' }
    ],
    defaults: {},
    afterRead: (item) => { item.currency = 'SGD'; item.updatedAt = new Date().toISOString(); }
  },
  cash: {
    title: 'cash account',
    fields: [
      { key:'name',     label:'Account name', type:'text', required:true, placeholder:'DBS Multiplier' },
      { key:'account',  label:'Account type', type:'select', options:[['Savings','Savings'],['Current','Current'],['FD','Fixed deposit'],['MMF','Money market'],['Brokerage','Brokerage cash'],['Foreign','Foreign currency'],['Other','Other']], default:'Savings' },
      { key:'amount',   label:'Balance', type:'number', step:'0.01', min:'0', placeholder:'10000', hint:'The balance as of the date on the right. Cash movements dated after it (e.g. auto salary) accrue on top. For Brokerage accounts leave blank — it is calculated from movements + linked trades below.' },
      { key:'asOf',     label:'Balance as of', type:'date', hint:'Movements dated after this accrue on top; anything on/before is assumed already inside the balance. Defaults to today.' },
      { key:'currency', label:'Currency', type:'select', options:[['SGD','SGD'],['USD','USD'],['EUR','EUR'],['GBP','GBP'],['HKD','HKD'],['JPY','JPY'],['AUD','AUD'],['MYR','MYR'],['Other','Other']], default:'SGD' },
      { key:'apy',      label:'Interest rate % p.a. (APY)', type:'number', step:'0.01', min:'0', placeholder:'0.00', hint:'Annual yield. Shown as projected monthly / annual interest. Leave blank for non-interest-bearing accounts.' },
      { key:'notes',    label:'Notes', type:'textarea' }
    ],
    defaults: { account:'Savings', currency:'SGD' }
  },
  cashTxns: {
    title: 'cash movement',
    fields: [
      { key:'type',   label:'Type', type:'select', required:true,
        options:[['deposit','Deposit'],['withdrawal','Withdrawal'],['transfer','Transfer between accounts'],['dividend','Dividend'],['interest','Interest'],['fee','Fee'],['adjustment','Adjustment (+/-)']], default:'deposit',
        hint:'Deposit/dividend/interest add; withdrawal/fee subtract; transfer moves between two accounts; adjustment uses the sign you enter.' },
      { key:'cashAccountId', label:'Account (or "to" for a transfer)', type:'select', required:true,
        optionsFn: () => (DB.cash || []).map(c => [c.id, (c.name || '?') + ' · ' + (c.currency || 'SGD')]),
        hint:'For a transfer, this is the destination account.' },
      { key:'fromAccountId', label:'From account (transfers only)', type:'select',
        optionsFn: () => [['', '— n/a —']].concat((DB.cash || []).map(c => [c.id, (c.name || '?') + ' · ' + (c.currency || 'SGD')])),
        hint:'Source account. Leave as n/a unless this is a transfer.' },
      { key:'date',   label:'Date', type:'date', required:true },
      { key:'amount', label:'Amount', type:'number', required:true, step:'0.01', min:'0', placeholder:'1000.00', hint:'Amount leaving the source, in its currency.' },
      { key:'amountIn', label:'Amount received (cross-currency transfers)', type:'number', step:'0.01', placeholder:'auto',
        hint:'Only for transfers where the two accounts use different currencies. Leave blank if same currency.' },
      { key:'notes',  label:'Notes', type:'textarea' }
    ],
    defaults: { date: new Date().toISOString().slice(0,10), type:'deposit', fromAccountId:'' }
  },
  cpfHistory: {
    title: 'CPF entry',
    fields: [
      { key:'date',     label:'Date',    type:'date',   required:true },
      { key:'type',     label:'Type',    type:'select', required:true,
        options:[['contribution','Contribution'],['interest','Interest credit'],['transfer','Transfer'],['withdrawal','Withdrawal'],['adjustment','Adjustment']], default:'contribution',
        hint:'Use negative amount for outflows (withdrawals or transfer-out).' },
      { key:'account',  label:'Account', type:'select', required:true,
        options:[['OA','OA'],['SA','SA'],['MA','MA'],['RA','RA']], default:'OA' },
      { key:'amount',   label:'Amount (SGD)', type:'number', required:true, step:'0.01', placeholder:'850.00',
        hint:'Enter a positive number. Withdrawals are stored as outflows automatically. Adjustments and transfers keep the sign you enter.' },
      { key:'source',   label:'Source / reference', type:'text', placeholder:'March salary, year-end interest, etc.' },
      { key:'notes',    label:'Notes', type:'textarea' }
    ],
    defaults: { type:'contribution', account:'OA', date: new Date().toISOString().slice(0,10) },
    afterRead: (item) => {
      // Normalise sign by type so storage is uniformly signed: withdrawals are
      // always outflows, contributions/interest are always inflows. Transfers
      // and adjustments keep whatever sign the user entered (either direction).
      if (item.amount != null && item.amount !== ''){
        const amt = Number(item.amount);
        if (isFinite(amt)){
          if (item.type === 'withdrawal') item.amount = -Math.abs(amt);
          else if (item.type === 'contribution' || item.type === 'interest') item.amount = Math.abs(amt);
        }
      }
    }
  },
  income: {
    title: 'income entry',
    fields: [
      { key:'date',         label:'Pay date',    type:'date',   required:true },
      { key:'gross',        label:'Gross (SGD)', type:'number', required:true, step:'0.01', placeholder:'8000.00',
        hint:'Total before deductions.' },
      { key:'net',          label:'Take-home (SGD)', type:'number', step:'0.01', placeholder:'6500.00',
        hint:'Cash that hit your bank. Leave blank to default to gross minus employee CPF.' },
      { key:'employerCPF',  label:'Employer CPF', type:'number', step:'0.01', placeholder:'1360.00' },
      { key:'employeeCPF',  label:'Employee CPF', type:'number', step:'0.01', placeholder:'1600.00' },
      { key:'source',       label:'Source / employer', type:'text', placeholder:'ACME Corp' },
      { key:'notes',        label:'Notes', type:'textarea' }
    ],
    defaults: { date: new Date().toISOString().slice(0,10) }
  },
  expenses: {
    title: 'expense',
    fields: [
      { key:'date',        label:'Date',        type:'date',   required:true },
      { key:'amount',      label:'Amount',      type:'number', required:true, step:'0.01', min:'0', placeholder:'45.50' },
      { key:'currency',    label:'Currency',    type:'select', options:[['SGD','SGD'],['USD','USD'],['EUR','EUR'],['GBP','GBP'],['HKD','HKD'],['JPY','JPY'],['AUD','AUD'],['MYR','MYR']], default:'SGD' },
      { key:'category',    label:'Category',    type:'select', required:true,
        optionsFn: () => (DB.categories && DB.categories.expense || []).map(c => [c, c]),
        default: 'Other' },
      { key:'subcategory', label:'Sub-category', type:'text',  placeholder:'Optional, e.g. groceries' },
      { key:'merchant',    label:'Merchant',     type:'text',  placeholder:'NTUC FairPrice' },
      { key:'notes',       label:'Notes',        type:'textarea' }
    ],
    defaults: { date: new Date().toISOString().slice(0,10), currency:'SGD', category:'Other' }
  }
};

function openEntityModal(table, existingId){
  const schema = ENTITY_SCHEMAS[table];
  if (!schema) return;
  const list = DB[table] || [];
  const existing = existingId ? list.find(x => x.id === existingId) : null;
  const item = existing ? Object.assign({}, existing) : Object.assign({ id: uid(table) }, schema.defaults);
  _modalState = { table, item, isNew: !existing };

  document.getElementById('em-title').textContent = (existing ? 'Edit ' : 'Add ') + schema.title;
  const body = document.getElementById('em-body');
  body.innerHTML = '<div class="form-row">' + schema.fields.map(f => renderField(f, item[f.key])).join('') + '</div>';

  // Cash movements: the source-account and cross-currency "amount received"
  // fields only make sense for a transfer. For a plain deposit/withdrawal they
  // are noise, so hide them (and simplify the account label) unless the type is
  // Transfer. Re-runs on every type change.
  if (table === 'cashTxns'){
    const typeSel   = body.querySelector('[data-fkey="type"]');
    const acctGrp   = body.querySelector('[data-fkey="cashAccountId"]');
    const fromEl    = body.querySelector('[data-fkey="fromAccountId"]');
    const amtInEl   = body.querySelector('[data-fkey="amountIn"]');
    const fromGrp   = fromEl  ? fromEl.closest('.form-group')  : null;
    const amtInGrp  = amtInEl ? amtInEl.closest('.form-group') : null;
    const acctLabel = acctGrp ? acctGrp.closest('.form-group').querySelector('.lbl') : null;
    const acctHint  = acctGrp ? acctGrp.closest('.form-group').querySelector('.hint') : null;
    const syncCashFields = () => {
      const isTransfer = typeSel && typeSel.value === 'transfer';
      if (fromGrp)   fromGrp.style.display  = isTransfer ? '' : 'none';
      if (amtInGrp)  amtInGrp.style.display = isTransfer ? '' : 'none';
      if (acctLabel) acctLabel.textContent = (isTransfer ? 'To account' : 'Account') + ' *';
      if (acctHint)  acctHint.style.display = isTransfer ? '' : 'none';
      // Drop any stale transfer-only values so a deposit never saves a source.
      if (!isTransfer){ if (fromEl) fromEl.value = ''; if (amtInEl) amtInEl.value = ''; }
    };
    if (typeSel) typeSel.addEventListener('change', syncCashFields);
    syncCashFields();
  }

  // Cash accounts: default the "Balance as of" anchor to today so a freshly
  // typed balance means "as of now" and only later movements accrue. Brokerage
  // balances are fully derived from trades, so the anchor is meaningless there —
  // hide and clear it when the type is Brokerage.
  if (table === 'cash'){
    const acctTypeSel = body.querySelector('[data-fkey="account"]');
    const asOfEl      = body.querySelector('[data-fkey="asOf"]');
    const asOfGrp     = asOfEl ? asOfEl.closest('.form-group') : null;
    if (asOfEl && !asOfEl.value) asOfEl.value = _isoDateSG(new Date());
    const syncAcctFields = () => {
      const isBrokerage = acctTypeSel && acctTypeSel.value === 'Brokerage';
      if (asOfGrp) asOfGrp.style.display = isBrokerage ? 'none' : '';
      if (isBrokerage && asOfEl) asOfEl.value = '';
    };
    if (acctTypeSel) acctTypeSel.addEventListener('change', syncAcctFields);
    syncAcctFields();
  }

  // Wire up market → currency coercion for stocks (nice UX)
  if (table === 'stocks'){
    const marketSel = body.querySelector('[data-fkey="market"]');
    const currSel   = body.querySelector('[data-fkey="currency"]');
    if (marketSel && currSel){
      marketSel.addEventListener('change', () => {
        currSel.value = marketSel.value === 'SGX' ? 'SGD' : 'USD';
      });
    }
  }

  // Sector auto-fill: on symbol blur, fetch Yahoo assetProfile and fill sector
  // if sync is configured and sector is not yet set.
  if ((table === 'stocks' || table === 'watchlist') && getSyncUrl()){
    const symbolInput = body.querySelector('[data-fkey="symbol"]');
    const sectorSel   = body.querySelector('[data-fkey="sector"]');
    if (symbolInput && sectorSel){
      symbolInput.addEventListener('blur', async () => {
        const sym = symbolInput.value.trim().toUpperCase();
        if (!sym || sectorSel.value) return;
        const mktEl = body.querySelector('[data-fkey="market"]');
        const ysym  = yahooSymbol({ symbol: sym, market: mktEl ? mktEl.value : 'US' });
        try {
          const base = getSyncUrl();
          const url  = base + (base.includes('?') ? '&' : '?') + 'action=profile&symbol=' + encodeURIComponent(ysym);
          const r = await fetch(url);
          const d = await r.json();
          const gics = d && d.sector ? (YAHOO_SECTOR_TO_GICS[d.sector] || null) : null;
          if (gics && !sectorSel.value) sectorSel.value = gics;
        } catch (_) { /* best-effort, sector stays manual */ }
      });
    }
  }

  document.getElementById('em-delete').style.display = existing ? '' : 'none';
  _modalOpener = document.activeElement;
  const _overlay = document.getElementById('entity-modal');
  if (_modalKeyTrap) _overlay.removeEventListener('keydown', _modalKeyTrap);
  _modalKeyTrap = function(e){
    if (e.key === 'Escape'){ e.preventDefault(); closeEntityModal(); return; }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(_overlay.querySelectorAll(
      'input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])'
    )).filter(el => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey){ if (document.activeElement === first){ e.preventDefault(); last.focus(); } }
    else           { if (document.activeElement === last) { e.preventDefault(); first.focus(); } }
  };
  _overlay.addEventListener('keydown', _modalKeyTrap);
  _overlay.classList.add('open');
  setTimeout(() => { const first = body.querySelector('input,select,textarea'); if (first) first.focus(); }, 50);
}

function renderField(f, value){
  const v = value == null ? (f.default == null ? '' : f.default) : value;
  const safeV = kjrEscape(v);
  const required = f.required ? ' required' : '';
  const hint = f.hint ? `<div class="hint">${kjrEscape(f.hint)}</div>` : '';
  const full = (f.type === 'textarea') ? ' style="grid-column:1/-1"' : '';
  let input = '';
  if (f.type === 'select'){
    // optionsFn lets schemas defer choices to render time (e.g. categories pulled from DB)
    const optList = f.optionsFn ? (f.optionsFn() || []) : (f.options || []);
    const opts = optList.map(o => {
      const [val,lbl] = Array.isArray(o) ? o : [o,o];
      return `<option value="${kjrEscape(val)}"${String(val) === String(v) ? ' selected' : ''}>${kjrEscape(lbl)}</option>`;
    }).join('');
    input = `<select class="fi" data-fkey="${f.key}"${required}>${opts}</select>`;
  } else if (f.type === 'textarea'){
    input = `<textarea class="fi" data-fkey="${f.key}" placeholder="${kjrEscape(f.placeholder||'')}">${safeV}</textarea>`;
  } else {
    const step = f.step ? ` step="${kjrEscape(f.step)}"` : '';
    const min  = f.min != null ? ` min="${kjrEscape(f.min)}"` : '';
    const inputType = f.type === 'number' ? 'number' : (f.type === 'date' ? 'date' : 'text');
    input = `<input class="fi" type="${inputType}" data-fkey="${f.key}"${step}${min} value="${safeV}" placeholder="${kjrEscape(f.placeholder||'')}"${required}>`;
  }
  return `<div class="form-group"${full}><label class="lbl">${kjrEscape(f.label)}${f.required ? ' *' : ''}</label>${input}${hint}</div>`;
}

function closeEntityModal(){
  const overlay = document.getElementById('entity-modal');
  if (_modalKeyTrap){ overlay.removeEventListener('keydown', _modalKeyTrap); _modalKeyTrap = null; }
  overlay.classList.remove('open');
  _modalState = null;
  if (_modalOpener && typeof _modalOpener.focus === 'function'){ try { _modalOpener.focus(); } catch (_){} }
  _modalOpener = null;
}

function entityModalSave(){
  if (!_modalState) return;
  pushUndo();
  const { table, item, isNew } = _modalState;
  const schema = ENTITY_SCHEMAS[table];

  // Read fields through the right sanitiser for each type. Strings get
  // control-char stripping + length cap (500 default, 5000 for textareas).
  // Numbers get isFinite checks; non-finite becomes null and trips required.
  const body = document.getElementById('em-body');
  let invalidDateLabel = null;   // non-blank but calendar-invalid date (e.g. 2026-02-30): block save, distinct from "left blank"
  for (const f of schema.fields){
    const el = body.querySelector(`[data-fkey="${f.key}"]`);
    if (!el) continue;
    const raw = el.value;
    if (f.type === 'number') {
      item[f.key] = kjrSafeNumber(raw);
    } else if (f.type === 'select' || f.type === 'date') {
      // Selects: must be one of the declared options. Date: ISO yyyy-mm-dd
      // format plus a real calendar check (kjrValidDate), not just the shape.
      if (f.type === 'select') {
        const optList = f.optionsFn ? (f.optionsFn() || []) : (f.options || []);
        const allowed = optList.map(o => String(Array.isArray(o) ? o[0] : o));
        item[f.key] = allowed.includes(String(raw)) ? String(raw) : (f.default || allowed[0] || '');
      } else if (f.type === 'date') {
        if (raw && !kjrValidDate(raw)) invalidDateLabel = f.label;
        item[f.key] = kjrValidDate(raw) ? raw : '';
      } else {
        item[f.key] = kjrSafeString(raw, 80);
      }
    } else if (f.type === 'textarea') {
      item[f.key] = kjrSafeString(String(raw).trim(), 5000);
    } else {
      item[f.key] = kjrSafeString(String(raw).trim(), 120);
    }
  }

  if (invalidDateLabel){ showToast('Invalid date: ' + invalidDateLabel, 'error'); return; }

  // Validate required
  for (const f of schema.fields){
    if (!f.required) continue;
    const val = item[f.key];
    if (val == null || val === '' || (f.type === 'number' && !isFinite(val))){
      showToast('Required: ' + f.label, 'error'); return;
    }
  }

  if (schema.afterRead) schema.afterRead(item);

  // Over-sell guard: warn (but allow) if a sell exceeds shares held as of its
  // date. Out-of-order or correcting entries are legitimate, so this confirms
  // rather than blocks.
  if (table === 'stockTxns' && item.side === 'sell'){
    const held = sharesHeldAsOf(item.stockId, item.date, item.id);
    const qty  = Math.abs(Number(item.shares) || 0);
    if (qty > held + OVERSOLD_EPSILON){
      const sym = (DB.stocks.find(s => s.id === item.stockId) || {}).symbol || 'this stock';
      if (!confirm('This sells ' + qty + ' shares of ' + sym + ' but only ' + (held > 0 ? held : 0) + ' were held as of ' + fmtDateSG(item.date) + '.\n\nSave anyway?')) return;
    }
  }

  // Transfer validation: needs a distinct source; cross-currency needs the
  // received amount or the two sides won't reconcile.
  if (table === 'cashTxns' && item.type === 'transfer'){
    if (!item.fromAccountId){ showToast('Transfer needs a "From account"', 'error'); return; }
    if (item.fromAccountId === item.cashAccountId){ showToast('Transfer source and destination must differ', 'error'); return; }
    const fromAcct = (DB.cash || []).find(c => c.id === item.fromAccountId);
    const toAcct   = (DB.cash || []).find(c => c.id === item.cashAccountId);
    const fromCcy = fromAcct ? (fromAcct.currency || 'SGD') : 'SGD';
    const toCcy   = toAcct ? (toAcct.currency || 'SGD') : 'SGD';
    const hasIn = item.amountIn != null && isFinite(item.amountIn);
    if (fromCcy !== toCcy && !hasIn){
      if (!confirm(fromCcy + ' → ' + toCcy + ' transfer with no received amount. Both sides will use ' + fmt(toSGD(Number(item.amount)||0, fromCcy)) + ', which is wrong across currencies.\n\nEnter "Amount received" for an exact figure, or save anyway?')) return;
    }
  }

  // Trade funded from a cash account in a different currency: flag, since we
  // do not auto-convert the cash leg. Same-currency keeps the math exact.
  if (table === 'stockTxns' && item.cashAccountId){
    const stock = DB.stocks.find(s => s.id === item.stockId);
    const acct  = (DB.cash || []).find(c => c.id === item.cashAccountId);
    if (stock && acct){
      const stockCcy = stock.currency || (stock.market === 'SGX' ? 'SGD' : 'USD');
      const acctCcy  = acct.currency || 'SGD';
      if (stockCcy !== acctCcy){
        if (!confirm('This trade is in ' + stockCcy + ' but ' + (acct.name || 'the cash account') + ' holds ' + acctCcy + '. The cash leg will not be currency-converted, so the balance may be off.\n\nLink anyway?')) return;
      }
    }
  }

  // Defence-in-depth: ids must match the safe regex. Regenerate if not.
  if (!kjrSafeId(item.id)) item.id = uid(table);

  item.updatedAt = new Date().toISOString();
  if (isNew) item.createdAt = item.updatedAt;

  if (isNew){
    if (!DB[table]) DB[table] = [];
    DB[table].push(item);
  } else {
    const idx = DB[table].findIndex(x => x.id === item.id);
    if (idx >= 0) DB[table][idx] = item;
  }
  saveData();
  closeEntityModal();
  renderAll();
  showToast(isNew ? 'Added' : 'Saved', 'success');

  // A stock/watchlist row added (or repointed at a new symbol) has no cached
  // quote yet, so its price + fundamentals cells render as '—'. Fire a silent
  // price refresh so the row fills in now instead of waiting for the next
  // manual/auto refresh. priceFor() is null only when the symbol is unquoted,
  // so a plain note/target edit on an already-quoted row will not refire.
  if ((table === 'stocks' || table === 'watchlist') && !priceFor(table, item)){
    refreshStockPrices({ silent: true });
  }
}

function entityModalDelete(){
  if (!_modalState || _modalState.isNew) return;
  const { table, item } = _modalState;

  // Referential-integrity guard: warn if deleting this would orphan movements
  // or trades that point at it, which would unbalance the books.
  let refWarning = '';
  if (table === 'cash'){
    const moves = (DB.cashTxns || []).filter(t => t.cashAccountId === item.id || t.fromAccountId === item.id).length;
    const trades = (DB.stockTxns || []).filter(t => t.cashAccountId === item.id).length;
    if (moves || trades){
      const parts = [];
      if (moves) parts.push(moves + ' cash movement' + (moves > 1 ? 's' : ''));
      if (trades) parts.push(trades + ' linked trade' + (trades > 1 ? 's' : ''));
      refWarning = 'This account is referenced by ' + parts.join(' and ') + '. Deleting it will leave those entries pointing at a missing account and unbalance the books.\n\n';
    }
  } else if (table === 'stocks'){
    const trades = (DB.stockTxns || []).filter(t => t.stockId === item.id).length;
    if (trades) refWarning = 'This stock has ' + trades + ' trade' + (trades > 1 ? 's' : '') + ' in the ledger that will be left orphaned.\n\n';
  }

  const prompt = refWarning + 'Move this entry to trash? You can restore it from Settings → Recently deleted.';
  if (!confirm(prompt)) return;
  pushUndo();
  sendToTrash(table, item.id);
  closeEntityModal();
  renderAll();
  showToast('Moved to trash', 'success');
}

/* ═══════════════════════════════════════════════════════════════════════
   STOCK TRADE LEDGER — derive position from transactions
   ═══════════════════════════════════════════════════════════════════════ */
/* Average-cost method. Returns null when a stock has no logged trades, so
   the caller falls back to the manually-entered shares/avgCost. When trades
   exist, the manually-entered shares/avgCost are the OPENING position and the
   trades adjust it from there (so selling 10 of a 3,000 holding leaves 2,990).
   Values are in the stock's own currency (price/fees in that currency). */
function deriveStockPosition(stockId){
  // Sort is stable: same-date trades resolve in ledger insertion order, which
  // becomes the avg-cost path for ties. A trade with no date sorts first.
  const txns = (DB.stockTxns || [])
    .filter(t => t.stockId === stockId)
    .sort((a,b) => String(a.date||'').localeCompare(String(b.date||'')));
  if (!txns.length) return null;
  const stock = (DB.stocks || []).find(s => s.id === stockId) || {};
  return computeStockPosition(Number(stock.shares) || 0, Number(stock.avgCost) || 0, txns);
}

/* Shares held for a stock as of a date, ignoring one transaction (the one
   being edited). Includes the manually-entered opening position so the
   over-sell warning matches the derived holding. */
function sharesHeldAsOf(stockId, asOfDate, excludeTxnId){
  const stock = (DB.stocks || []).find(s => s.id === stockId) || {};
  const opening = Number(stock.shares) || 0;
  return opening + (DB.stockTxns || [])
    .filter(t => t.stockId === stockId && t.id !== excludeTxnId && String(t.date || '') <= String(asOfDate || ''))
    .reduce((sh, t) => sh + (t.side === 'sell' ? -1 : 1) * Math.abs(Number(t.shares) || 0), 0);
}

/* ═══════════════════════════════════════════════════════════════════════
   STOCKS — render
   ═══════════════════════════════════════════════════════════════════════ */
/* ─── Holdings filter state (ephemeral, not persisted) ─────────────────── */
let _stocksFilter  = { sector:'', market:'' };
let _stocksPage    = 0;                 // 0-based page for the Holdings table
const STOCKS_PAGE_SIZE = 50;            // rows per page; pager only shows beyond this
let _sfText = 'No prices yet';
let _sfCls  = '';
let _lastStockRows = [];  // cache for CSV export — always reflects what's on screen
let _ledgerView    = 'flat'; // 'flat' or 'by-stock'


/* ─── CSV helpers ─────────────────────────────────────────────────────── */
function downloadCSV(filename, headers, rows){
  const esc = v => {
    const s = v == null ? '' : String(v).replace(/"/g,'""');
    return /[",\n]/.test(s) ? '"'+s+'"' : s;
  };
  const lines = [headers.map(esc).join(',')].concat(rows.map(r => r.map(esc).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type:'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href:URL.createObjectURL(blob), download:filename });
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function exportHoldingsCSV(){
  if (!_lastStockRows.length){ showToast('No holdings to export'); return; }
  const headers = ['Symbol','Market','Sector','Shares','Avg Cost (SGD)','Cost Basis (SGD)','Price (SGD)','Market Value (SGD)','P&L (SGD)','P&L %','Dividend/yr (SGD)','Yield on Cost %','Weight %'];
  const rows = _lastStockRows.map(r => [
    r.s.symbol,
    r.s.market,
    r.s.sector || '',
    r.shares,
    r.avgCost != null ? toSGD(r.avgCost, r.ccy) : '',
    r.cost != null ? r.cost : '',
    r.priceSgd != null ? r.priceSgd : '',
    r.mv != null ? r.mv : '',
    r.pl != null ? r.pl : '',
    r.plPct != null ? r.plPct.toFixed(2) : '',
    r.divAnnualSgd != null ? r.divAnnualSgd : '',
    r.divYoc != null ? r.divYoc.toFixed(2) : '',
    r.weight != null ? r.weight.toFixed(2) : ''
  ]);
  downloadCSV('kujira-holdings-' + _isoDateSG(new Date()) + '.csv', headers, rows);
}

function exportLedgerCSV(){
  const stocks = DB.stocks || [];
  const txns = (DB.stockTxns || []).slice().sort((a,b) => String(b.date||'').localeCompare(String(a.date||'')));
  if (!txns.length){ showToast('No trades to export'); return; }
  const symbolOf = id => { const s = stocks.find(x => x.id === id); return s ? s.symbol : ''; };
  const ccyOf    = id => { const s = stocks.find(x => x.id === id); return s ? (s.currency || (s.market === 'SGX' ? 'SGD' : 'USD')) : 'SGD'; };
  const headers = ['Date','Symbol','Side','Shares','Price (SGD)','Fees (SGD)','Value (SGD)','Notes'];
  const rows = txns.map(t => {
    const ccy   = ccyOf(t.stockId);
    const qty   = Number(t.shares) || 0;
    const px    = Number(t.price)  || 0;
    const fees  = Number(t.fees)   || 0;
    const gross = px * qty;
    const value = t.side === 'sell' ? gross - fees : gross + fees;
    return [
      t.date,
      symbolOf(t.stockId),
      t.side,
      qty,
      toSGD(px, ccy),
      fees ? toSGD(fees, ccy) : '',
      toSGD(value, ccy),
      t.notes || ''
    ];
  });
  downloadCSV('kujira-trades-' + _isoDateSG(new Date()) + '.csv', headers, rows);
}

/* ─── IBKR CSV import ───────────────────────────────────────────────────
   ibkrFileSelected: FileReader entry point, reads the .csv then shows preview.
   ibkrShowPreview:  renders the preview modal (summary + scrollable table).
   ibkrConfirmImport: commits new trades (and new-stock stubs) then closes.   */
function ibkrFileSelected(input){
  const file = input.files && input.files[0];
  if (!file) return;
  input.value = ''; // reset so the same file can be re-selected
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const rows    = parseCSV(e.target.result);
      const { trades, skipped } = ibkrExtractTrades(rows);
      if (!trades.length){ showToast('No eligible trades found in this file', 'error'); return; }
      const matched = ibkrMatchTrades(trades, DB.stocks || [], DB.stockTxns || []);
      ibkrShowPreview(matched, skipped);
    } catch (err) {
      showToast('Parse error: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

function ibkrShowPreview(matched, skippedCount){
  const newTrades   = matched.filter(t => t.status === 'new');
  const dupTrades   = matched.filter(t => t.status === 'dup');
  const newStocks   = matched.filter(t => t.status === 'new-stock');
  const totalCount  = matched.length + skippedCount;
  const LARGE_WARN  = (DB.stockTxns || []).length + newTrades.length > 300;

  const chipCls = { 'new':'pos', 'dup':'muted', 'new-stock':'warn' };
  const chipLbl = { 'new':'new', 'dup':'dup', 'new-stock':'new stock' };

  const chipTitle = { 'dup':'Matches a trade already in the ledger. Skipped unless you tick it (e.g. two identical trades on the same day).' };
  const tableRows = matched.map((t, idx) => {
    const ccySym = t.currency === 'SGD' ? 'S$' : 'US$';
    const ccy    = t.currency || 'USD';
    const ccyMismatch = t.stockId && (() => {
      const s = (DB.stocks || []).find(x => x.id === t.stockId);
      return s && (s.currency || (s.market === 'SGX' ? 'SGD' : 'USD')) !== ccy;
    })();
    // Dups are skipped by default, but a checkbox lets the user force-import a
    // genuine repeat trade (same symbol/date/side/size/price) rather than lose it.
    const statusCell = t.status === 'dup'
      ? `<label class="ibkr-dup-opt" title="${kjrEscape(chipTitle.dup)}"><input type="checkbox" data-ibkr-dup="${idx}"> <span class="tag muted">possible dup</span></label>`
      : `<span class="tag ${chipCls[t.status]}" ${chipTitle[t.status] ? 'title="' + kjrEscape(chipTitle[t.status]) + '"' : ''}>${chipLbl[t.status]}</span>`;
    return `<tr${ccyMismatch ? ' class="warn-row"' : ''}>
      <td class="tl">${kjrEscape(fmtDateSG(t.date))}</td>
      <td class="tl">${kjrEscape(t.symbol)}</td>
      <td class="tl"><span class="tag ${t.side === 'sell' ? 'neg' : 'pos'}">${t.side.toUpperCase()}</span></td>
      <td class="num">${t.shares}</td>
      <td class="num">${ccySym}${t.price.toFixed(4)}</td>
      <td class="num muted">${t.fees ? ccySym + t.fees.toFixed(2) : '—'}</td>
      <td class="tl">${statusCell}${ccyMismatch ? ' ⚠' : ''}</td>
    </tr>`;
  }).join('');

  const warnHtml = LARGE_WARN
    ? `<div class="alert alert-warn" style="margin:.5rem 1rem">Large ledgers may exceed the cloud sync size cap (~300 trades).</div>`
    : '';

  const overlay = document.getElementById('ibkr-preview-overlay');
  const html = `
    <div class="modal-box" style="max-width:700px;width:95vw">
      <div class="modal-head"><h3>IBKR import preview</h3></div>
      <div class="modal-body" style="padding:1rem">
        <p style="margin:0 0 .75rem">Found <strong>${matched.length}</strong> trades
          (${totalCount} in file, ${skippedCount} non-equity/ClosedLot skipped):
          <span class="tag pos">${newTrades.length} new</span>
          <span class="tag muted">${dupTrades.length} dup</span>
          <span class="tag warn">${newStocks.length} new stock</span>
        </p>
        ${warnHtml}
        <div class="tbl-wrap" style="max-height:340px;overflow-y:auto">
          <table class="tbl" style="font-size:.8rem">
            <thead><tr>
              <th class="tl">Date</th><th class="tl">Symbol</th><th class="tl">Side</th>
              <th>Shares</th><th>Price</th><th>Fees</th><th>Status</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
        ${dupTrades.length ? '<p style="margin:.5rem 0 0;font-size:.8rem;color:var(--tx2)">Duplicates are skipped by default. Tick one to import it anyway, e.g. two genuinely identical trades on the same day.</p>' : ''}
        ${newStocks.length ? '<p style="margin:.5rem 0 0;font-size:.8rem;color:var(--tx2)">New stocks will be created as stubs, add sector, cost currency, and notes after import.</p>' : ''}
      </div>
      <div class="modal-foot" style="padding:.75rem 1rem;display:flex;gap:.5rem;justify-content:flex-end">
        <button class="btn btn-ghost" data-click="closeIbkrPreview">Cancel</button>
        <button class="btn btn-primary" data-click="ibkrConfirmImport" ${newTrades.length + newStocks.length + dupTrades.length === 0 ? 'disabled' : ''}>
          Import ${newTrades.length + newStocks.length} trade${newTrades.length + newStocks.length !== 1 ? 's' : ''}
        </button>
      </div>
    </div>`;

  // Store matched set on the overlay for ibkrConfirmImport to read
  overlay.dataset.matched = JSON.stringify(matched);
  overlay.innerHTML = html;
  overlay.classList.add('open');
}

function ibkrConfirmImport(){
  const overlay = document.getElementById('ibkr-preview-overlay');
  let matched;
  try { matched = JSON.parse(overlay.dataset.matched || '[]'); } catch(_){ matched = []; }
  // Read which dup rows the user opted to force-import, BEFORE tearing down the
  // overlay (its DOM, and the checkbox state, disappear on close).
  const forcedDupIdx = new Set(
    Array.from(overlay.querySelectorAll('input[data-ibkr-dup]:checked'))
      .map(el => Number(el.getAttribute('data-ibkr-dup')))
  );
  overlay.classList.remove('open');

  const now = new Date().toISOString();
  let addedTrades = 0, addedStocks = 0;

  // Create stubs for new-stock entries (unique by symbol)
  const newStockSymbols = {};
  matched.filter(t => t.status === 'new-stock').forEach(t => {
    if (newStockSymbols[t.symbol]) return;
    const stub = {
      id: uid('stocks'), symbol: t.symbol,
      market: t.market || 'US',
      currency: t.currency || 'USD',
      shares: 0, avgCost: 0,
      notes: 'Auto-created from IBKR import',
      createdAt: now, updatedAt: now
    };
    newStockSymbols[t.symbol] = stub.id;
    (DB.stocks = DB.stocks || []).push(stub);
    addedStocks++;
  });

  // Commit new trades, plus any dup rows the user explicitly ticked.
  matched.forEach((t, idx) => {
    if (t.status === 'dup' && !forcedDupIdx.has(idx)) return;   // skip un-ticked dups
    if (t.status === 'new-stock' || t.status === 'new' || (t.status === 'dup' && forcedDupIdx.has(idx))){
      const stockId = t.stockId || newStockSymbols[t.symbol];
      if (!stockId) return;
      (DB.stockTxns = DB.stockTxns || []).push({
        id: uid('stockTxns'), stockId,
        date: t.date, side: t.side,
        shares: t.shares, price: t.price, fees: t.fees || 0,
        cashAccountId: '', notes: '', createdAt: now, updatedAt: now
      });
      addedTrades++;
    }
  });

  saveData();
  renderAll();
  showToast(`Imported ${addedTrades} trade${addedTrades !== 1 ? 's' : ''}${addedStocks ? ' + ' + addedStocks + ' new stock' + (addedStocks !== 1 ? 's' : '') : ''}`);
}

/* Compute the per-holding rows that BOTH the Holdings table and the Custom
   Chart Builder read, so the two always agree on every number. Pure over
   DB.stocks plus the price/FX caches (no DOM), sets _stockChartRows, and
   returns the rows. Safe to call from any tab — the builder now lives on the
   Dashboard, so it cannot rely on renderStocks having run first. */
function buildStockChartRows(){
  const list = DB.stocks || [];
  let totMv = 0;
  const rows = list.map(s => {
    const ysym  = yahooSymbol(s);
    const px    = DB._priceCache[ysym] || null;
    const ccy   = s.currency || (s.market === 'SGX' ? 'SGD' : 'USD');
    const derived = deriveStockPosition(s.id);
    const shares  = derived ? derived.shares  : (s.shares  || 0);
    const avgCost = derived ? derived.avgCost : (s.avgCost || 0);
    let realisedSgd = null;
    if (derived){ realisedSgd = roundMoney(toSGD(derived.realisedPL, ccy)); }
    const cost  = roundMoney(toSGD(shares * avgCost, ccy));
    let priceSgd = null, mv = null, pl = null, plPct = null, stale = true, priceCcy = null;
    let changeSgd = null, prevCloseSgd = null;
    if (px && px.price != null){
      const pxCcy = px.currency || ccy;
      priceSgd = toSGD(px.price, pxCcy);
      mv  = roundMoney(priceSgd * shares);
      pl  = roundMoney(mv - cost);
      plPct = safeRatio(pl, cost);
      stale = isStale(px.fetchedAt, 24);
      priceCcy = pxCcy;
      if (px.change != null) changeSgd = roundMoney(toSGD(px.change, pxCcy) * shares);
      if (px.previousClose != null) prevCloseSgd = toSGD(px.previousClose, pxCcy);
    }
    const dps = Number(s.divPerShare) || 0;
    let divAnnualSgd = null, divYoc = null, divYieldCur = null;
    if (dps > 0 && shares){
      divAnnualSgd = roundMoney(toSGD(shares * dps, ccy));
      divYoc = safeRatio(divAnnualSgd, cost);
      if (mv != null) divYieldCur = safeRatio(divAnnualSgd, mv);
    }
    let extLine = '';
    if (px && px.extendedKind && px.extendedPrice != null){
      const extCls = (px.extendedChange || 0) >= 0 ? 'pos' : 'neg';
      const elabel = px.extendedKind === 'pre' ? 'Pre' : 'Post';
      const pctTxt = px.extendedChangePct != null ? ' ' + fmtPct(px.extendedChangePct) : '';
      extLine = `<div class="px-ext"><span class="px-ext-tag">${elabel}</span> ${fmt(toSGD(px.extendedPrice, priceCcy))}<span class="${extCls}">${pctTxt}</span></div>`;
    }
    if (mv != null) totMv += mv;
    return { s, ysym, px, ccy, cost, mv, pl, plPct, stale, priceCcy, priceSgd, shares, avgCost, derived,
             realisedSgd, changeSgd, prevCloseSgd, divAnnualSgd, divYoc, divYieldCur, extLine, weight:null };
  });
  totMv = roundMoney(totMv);
  rows.forEach(r => { if (r.mv != null && totMv > 0) r.weight = safeRatio(r.mv, totMv); });
  _stockChartRows = rows;
  return rows;
}

function renderStocks(){
  setRenderCcy('stocks');
  const list = DB.stocks || [];
  const bodyEl = document.getElementById('stocks-body');
  const sumEl  = document.getElementById('stocks-summary');
  if (!bodyEl) return;

  // Empty state
  if (!list.length){
    _sfText = 'No prices yet'; _sfCls = '';
    sumEl.innerHTML = '';
    bodyEl.innerHTML = `<div class="card">
      <div class="card-head"><h3>Holdings</h3><button class="btn btn-primary btn-sm" data-click="openEntity" data-a0="stocks">＋ Add stock</button></div>
      <div class="card-body"><div class="empty"><div class="empty-icon">📈</div><div class="empty-title">No stocks yet</div><div class="empty-sub">Click <b>Add stock</b> to record your first position. SGX tickers are auto-suffixed with .SI for Yahoo Finance.</div><button class="btn btn-primary" data-click="openEntity" data-a0="stocks" style="margin-top:14px">＋ Add stock</button></div></div></div>`;
    _lastStockRows = [];
    _stockChartRows = [];
    renderWatchlist(); // the watchlist stands on its own, even with no holdings
    renderBoard();     // Watchlist+ board mirrors the same tickers
    renderDividendTimeline([]);
    return;
  }

  // Rows are built by the shared builder so the Holdings table and the Custom
  // Chart Builder always read identical numbers. Summary totals + state flags
  // are then derived from those rows in a single pass.
  const rows = buildStockChartRows();
  let totCost = 0, totMv = 0, totRealised = 0, totDivAnnual = 0,
      anyPriceMissing = false, anyFxMissing = false, anyPriced = false, anyDerived = false, anyDiv = false;
  rows.forEach(r => {
    totCost += r.cost;
    if (r.mv != null){ totMv += r.mv; anyPriced = true; } else { anyPriceMissing = true; }
    if (r.realisedSgd != null) totRealised += r.realisedSgd;
    if (r.derived) anyDerived = true;
    if (r.divAnnualSgd != null){ totDivAnnual += r.divAnnualSgd; anyDiv = true; }
    if (fxMissingFor(r.ccy) || (r.priceCcy && fxMissingFor(r.priceCcy))) anyFxMissing = true;
  });
  totCost = roundMoney(totCost); totMv = roundMoney(totMv);
  totRealised = roundMoney(totRealised); totDivAnnual = roundMoney(totDivAnnual);

  // Build sector options with current selection marked — used in the Holdings card-head.
  const sectorOpts = GICS_SECTOR_OPTIONS
    .filter(o => o[0])
    .map(o => `<option value="${kjrEscape(o[0])}"${_stocksFilter.sector===o[0]?' selected':''}>${kjrEscape(o[1])}</option>`)
    .join('');
  const anyFilter = _stocksFilter.market || _stocksFilter.sector;

  // Apply filter — summary cards always use the FULL rows (portfolio-wide).
  let filteredRows = rows;
  if (_stocksFilter.market) filteredRows = filteredRows.filter(r => r.s.market === _stocksFilter.market);
  if (_stocksFilter.sector) filteredRows = filteredRows.filter(r => r.s.sector === _stocksFilter.sector);

  // Filtered totals — used by the tfoot row so the footer always matches the visible set.
  let fTotCost=0, fTotMv=0, fTotRealised=0, fTotDiv=0, fAnyMv=false;
  filteredRows.forEach(r => {
    fTotCost += r.cost;
    if (r.mv != null){ fTotMv += r.mv; fAnyMv = true; }
    if (r.realisedSgd != null) fTotRealised += r.realisedSgd;
    if (r.divAnnualSgd != null) fTotDiv += r.divAnnualSgd;
  });
  fTotCost = roundMoney(fTotCost); fTotMv = roundMoney(fTotMv);
  fTotRealised = roundMoney(fTotRealised); fTotDiv = roundMoney(fTotDiv);
  const fTotPl    = roundMoney(fTotMv - fTotCost);
  const fTotPlPct = safeRatio(fTotPl, fTotCost);

  const showPl = anyPriced && !anyPriceMissing;
  const totPl = roundMoney(totMv - totCost);
  const totPlPct = safeRatio(totPl, totCost);
  const mvSub = anyFxMissing ? 'FX missing, set rate in Settings'
              : anyPriceMissing && anyPriced ? 'some prices missing, refresh'
              : anyPriceMissing ? 'click Refresh prices to populate'
              : '';

  const summaryItems = [
    { label:'Holdings',     value: String(list.length), accent:'accent' },
    { label:'Total cost',   value: fmt(totCost, {dp:0}), sub: anyFxMissing ? 'approximate (FX missing)' : '' },
    { label:'Market value', value: anyPriced ? fmt(totMv, {dp:0}) : '—', accent:'accent', sub: mvSub },
    { label:'Unrealised P&L', value: showPl ? fmt(totPl, {dp:0}) : '—',
      sub: showPl && totPlPct != null ? fmtPct(totPlPct) : (anyPriceMissing ? 'refresh prices to compute' : ''),
      accent: showPl ? (totPl >= 0 ? 'pos' : 'neg') : '' }
  ];
  const anySell = (DB.stockTxns || []).some(t => t.side === 'sell');
  if (anyDerived && anySell){
    summaryItems.push({ label:'Realised P&L', value: fmt(totRealised, {dp:0}), sub:'from closed trades',
      accent: totRealised >= 0 ? 'pos' : 'neg' });
  }
  if (anyDiv){
    const totDivYoc = safeRatio(totDivAnnual, totCost);
    summaryItems.push({ label:'Dividend income', value: fmt(totDivAnnual, {dp:0}),
      sub: fmt(roundMoney(totDivAnnual/12)) + ' / mo' + (totDivYoc != null ? ' · ' + totDivYoc.toFixed(2) + '% on cost' : ''),
      accent:'accent' });
  }
  const allocHtml = renderSectorAllocation(rows, anyPriceMissing);
  sumEl.innerHTML = allocHtml
    ? `<div class="sum-row">${renderSummary(summaryItems)}${allocHtml}</div>`
    : renderSummary(summaryItems);

  // Apply the persisted sort to the filtered set. Null values sort last in both directions.
  const sortPref = DB.settings.stocksSort || {};
  const sortFn = (sortPref.key && sortPref.dir) ? STOCK_SORT_VALS[sortPref.key] : null;
  if (sortFn){
    const dir = sortPref.dir === 'desc' ? -1 : 1;
    filteredRows.sort((a, b) => {
      const va = sortFn(a), vb = sortFn(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (typeof va === 'string' || typeof vb === 'string')
        ? dir * String(va).localeCompare(String(vb))
        : dir * (va - vb);
    });
  }

  // Cache for CSV export (always the FULL filtered set, not just the page).
  _lastStockRows = filteredRows;

  // Pagination: only the visible tbody is paged; summary + tfoot stay full-set.
  const totalRows = filteredRows.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / STOCKS_PAGE_SIZE));
  if (_stocksPage > pageCount - 1) _stocksPage = pageCount - 1;
  if (_stocksPage < 0) _stocksPage = 0;
  const pageRows = totalRows > STOCKS_PAGE_SIZE
    ? filteredRows.slice(_stocksPage * STOCKS_PAGE_SIZE, (_stocksPage + 1) * STOCKS_PAGE_SIZE)
    : filteredRows;

  const dc = displayCcy();
  const cols = orderedStockCols().filter(c => c.visible);
  const ctx = { dc, totMv };
  // Sortable header cell: reserved glyph space so the layout never shifts.
  const thSort = (key, lbl, extraCls) => {
    const active = sortPref.key === key && sortPref.dir;
    const glyph  = active ? `<span class="sort-glyph">${sortPref.dir === 'asc' ? '▲' : '▼'}</span>` : '';
    const aria   = active ? ` aria-sort="${sortPref.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th class="sortable${extraCls || ''}" data-sort-key="${key}" tabindex="0"${aria}>${lbl}${glyph}</th>`;
  };
  const headCells = cols.map(c => {
    const lbl = typeof c.label === 'function' ? c.label(dc) : c.label;
    const tl  = (c.cls && c.cls.indexOf('tl') > -1) ? ' tl' : '';
    return thSort(c.key, lbl, tl);
  }).join('');

  // Set freshness state before building the card-head so the span renders with correct text/class.
  _sfCls  = anyPriceMissing ? ' stale' : ' fresh';
  _sfText = priceFreshnessText('stocks');

  // Combined card-head right: filters + action buttons + freshness — shared by all table states.
  const cardHeadRight = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <select id="sf-market" class="fi fi-sm" data-change="stocksFilterMarket">
      <option value="">All markets</option>
      <option value="SGX"${_stocksFilter.market==='SGX'?' selected':''}>SGX</option>
      <option value="US"${_stocksFilter.market==='US'?' selected':''}>US</option>
    </select>
    <select id="sf-sector" class="fi fi-sm" data-change="stocksFilterSector">
      <option value="">All sectors</option>
      ${sectorOpts}
    </select>
    ${anyFilter ? `<button class="btn btn-sm btn-ghost" data-click="stocksClearFilter">Clear</button>` : ''}
    <button class="btn btn-primary btn-sm" data-click="openEntity" data-a0="stocks">＋ Add stock</button>
    <button class="btn btn-sm" data-click="exportHoldingsCSV">Export CSV</button>
    <button class="btn btn-sm" data-click="refreshStockPrices" id="btn-refresh-stocks">↻ Refresh prices</button>
    <button class="btn btn-sm" data-click="openStockColumns" id="btn-stock-cols">⚙ Columns</button>
    <span class="freshness${_sfCls}" id="freshness-stocks">${kjrEscape(_sfText)}</span>
  </div>`;

  // Empty filtered state — show a designed empty state so Clear is reachable.
  if (!filteredRows.length){
    bodyEl.innerHTML = `<div class="card">
      <div class="card-head"><h3>Holdings</h3>${cardHeadRight}</div>
      <div class="card-body"><div class="empty">
        <div class="empty-title">No holdings match your filter.</div>
      </div></div></div>`;
  } else {
    // Tfoot totals aligned to the visible column set.
    const totCells = cols.map(c => {
      switch(c.key){
        case 'mv':       return `<td class="num">${fAnyMv?fmt(fTotMv,{dp:0}):'—'}</td>`;
        case 'cost':     return `<td class="num">${fmt(fTotCost,{dp:0})}</td>`;
        case 'pl':       return `<td class="num">${fAnyMv?`<span class="${fTotPl>=0?'pos':'neg'}">${_plArrow(fTotPl)}${fmt(fTotPl,{dp:0,signed:true})}</span>`:'—'}</td>`;
        case 'plPct':    return `<td class="num">${fAnyMv&&fTotPlPct!=null?`<span class="${fTotPl>=0?'pos':'neg'}">${fmtPct(fTotPlPct)}</span>`:'—'}</td>`;
        case 'realised': return `<td class="num">${fTotRealised?`<span class="${fTotRealised>=0?'pos':'neg'}">${_plArrow(fTotRealised)}${fmt(fTotRealised,{dp:0,signed:true})}</span>`:'—'}</td>`;
        case 'divIncome':return `<td class="num">${fTotDiv?fmt(fTotDiv,{dp:0}):'—'}</td>`;
        default:         return `<td></td>`;
      }
    }).join('');

    bodyEl.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Holdings</h3>${cardHeadRight}</div>
        <div class="tbl-wrap"><table class="holdings"><thead><tr>
        ${thSort('symbol', 'Symbol', ' tl sticky-col')}${headCells}<th></th>
      </tr></thead><tbody>
        ${pageRows.map(r => {
          const cells = cols.map(c => `<td class="${c.cls}">${c.render(r, ctx)}</td>`).join('');
          const ax = encodeURIComponent(r.ysym);
          return `<tr>
            <td class="tl cell-sym sticky-col">${kjrEscape(r.s.symbol)}</td>
            ${cells}
            <td class="row-actions">
              <a class="btn btn-sm btn-ghost" href="../Trading/index.html?symbol=${ax}" target="_blank" rel="noopener" title="Open chart analysis for ${kjrEscape(r.s.symbol)}">Analyse</a>
              <button class="btn btn-sm btn-ghost btn-edit" data-edit-table="stocks" data-edit-id="${kjrEscape(r.s.id)}">Edit</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody><tfoot><tr class="totals-row">
        <td class="tl sticky-col"><strong>Total</strong></td>${totCells}<td></td>
      </tr></tfoot></table></div>
        ${pageCount > 1 ? `<div class="tbl-pager">
          <button class="btn btn-sm" ${_stocksPage <= 0 ? 'disabled' : ''} data-click="stocksPrevPage">‹ Prev</button>
          <span class="hint">Page ${_stocksPage + 1} of ${pageCount} · showing ${pageRows.length} of ${totalRows}</span>
          <button class="btn btn-sm" ${_stocksPage >= pageCount - 1 ? 'disabled' : ''} data-click="stocksNextPage">Next ›</button>
        </div>` : ''}
        <div class="tbl-note hint">Cost basis and average cost use the weighted-average method, not FIFO.</div>
      </div>
    `;
  }

  renderWatchlist();
  renderBoard();     // Watchlist+ board mirrors the same tickers
  renderDividendTimeline(rows);
  renderStockTxns();
}

/* ═══════════════════════════════════════════════════════════════════════
   CUSTOM CHART BUILDER (Stocks tab)
   A modular drag-and-drop chart builder over the holdings, ported from the
   Collectibles app. Two modes share one surface:
     • cross-sectional — group holdings by a dimension, aggregate a measure
     • time-series     — daily close (or position value) per symbol over a
                         period, with an optional dashed avg-cost line
   Aggregation + formatting live in kjr-core.js (kjrChartAggregate /
   kjrFmtMeasure / kjrFmtAxis) so the live chart and saved cards never drift.
   Builds on _stockChartRows, the SAME rows the Holdings table renders.
   ═══════════════════════════════════════════════════════════════════════ */
let _stockChartRows = [];
let _pbHistCache = {};                 // memory-only: { ysym: { range: {ccy, points, fetchedAt} } }
const _pbCharts = {};                  // canvasId -> Chart instance
const PB_PALETTE = ['#a78bfa','#2dd4bf','#f59e0b','#f87171','#60a5fa','#34d399','#fb923c','#c084fc','#38bdf8','#4ade80','#facc15','#e879f9'];
/* D1: these four were device-local localStorage keys (pre-v2.37). They now
   live in DB.settings so they ride sync, export and import like everything
   else. The old key names are kept here only as migration source keys
   (see migrateDeviceLocalChartState, called once on boot), nothing reads
   or writes them directly any more. */
const PB_STATE_KEY = 'kjr_pb_cb_state_v1';
const PB_SAVED_KEY  = 'kjr_portfolio_saved_charts';
const PB_SEEDED_KEY = 'kjr_pb_defaults_seeded_v1';
const DASH_LAYOUT_KEY = 'kjr_portfolio_dash_layout';
function loadDashLayout(){ return Array.isArray(DB.settings.dashLayout) ? DB.settings.dashLayout : []; }
function saveDashLayout(ids){ DB.settings.dashLayout = Array.isArray(ids) ? ids : []; saveData(); }
const PB_PERIODS = { ONE_MONTH:'1mo', THREE_MONTHS:'3mo', SIX_MONTHS:'6mo', ONE_YEAR:'1y', ALL:'all' };
const PB_PERIOD_LABELS = { ONE_MONTH:'1M', THREE_MONTHS:'3M', SIX_MONTHS:'6M', ONE_YEAR:'1Y', ALL:'All' };
const PB_SERIES_MODES = ['total','split','single','cpfCompare'];   // series-source view modes
const PB_CLASS_KEYS = ['stocks','cash','cpf','realestate','crypto']; // net-worth single-class keys
const PB_CLASS_LABELS = { stocks:'Stocks', cash:'Cash', cpf:'CPF', realestate:'Real Estate', crypto:'Crypto' };

/* Field schemas (per-source; money measures return raw SGD). */
const PB_HOLDINGS_FIELDS = {
  symbol:   { label:'Symbol',   type:'dim', get: r => r.s.symbol || '?' },
  market:   { label:'Market',   type:'dim', get: r => r.s.market || '?' },
  currency: { label:'Currency', type:'dim', get: r => r.ccy || '?' },
  sector:   { label:'Sector',   type:'dim', get: r => r.s.sector || 'Unclassified' },
  marketValue:{ label:'Market Value',    type:'meas', agg:'sum', unit:'money', get: r => r.mv ?? 0 },
  costBasis:  { label:'Cost Basis',      type:'meas', agg:'sum', unit:'money', get: r => r.cost ?? 0 },
  unrealPnl:  { label:'Unrealised P&L',  type:'meas', agg:'sum', unit:'money', get: r => r.pl ?? 0 },
  pnlPct:     { label:'P&L %',           type:'meas', agg:'avg', unit:'pct',   get: r => (r.plPct ?? 0) * 100 },
  shares:     { label:'Shares',          type:'meas', agg:'sum', unit:'count', get: r => r.shares ?? 0 },
  divIncome:  { label:'Annual Dividend', type:'meas', agg:'sum', unit:'money', get: r => r.divAnnualSgd ?? 0 },
  divYield:   { label:'Dividend Yield',  type:'meas', agg:'avg', unit:'pct',   get: r => (r.divYieldCur ?? 0) * 100 },
  weightPct:  { label:'Portfolio Weight',type:'meas', agg:'sum', unit:'pct',   get: r => (r.weight ?? 0) * 100 },
  posCount:   { label:'Position Count',  type:'meas', agg:'sum', unit:'count', get: () => 1 },
};
const PB_ALLOC_FIELDS = {
  assetClass: { label:'Asset Class', type:'dim',  get: r => r.cls },
  value:      { label:'Value',       type:'meas', agg:'sum', unit:'money', get: r => r.val },
  weightPct:  { label:'Weight',      type:'meas', agg:'sum', unit:'pct',   get: r => r.weight * 100 },
};
const PB_CASHFLOW_FIELDS = {
  month:   { label:'Month',    type:'dim',  get: r => r.month },
  income:  { label:'Income',   type:'meas', agg:'sum', unit:'money', get: r => r.income },
  expense: { label:'Expenses', type:'meas', agg:'sum', unit:'money', get: r => r.expense },
  net:     { label:'Net',      type:'meas', agg:'sum', unit:'money', get: r => r.net },
};

function _pbAllocRows(){
  const c = _netWorthClassesSGD();
  const net = c.stocks + c.cash + c.cpf + c.realestate + c.crypto;
  const defs = [
    ['Stocks',c.stocks],['Cash',c.cash],['CPF',c.cpf],['Real Estate',c.realestate],['Crypto',c.crypto]
  ];
  const rows = defs.filter(([,v]) => v > 0).map(([cls,v]) => ({ cls, val:v, weight:net>0?v/net:0 }));
  return _dashShowCpf ? rows : rows.filter(r => r.cls !== 'CPF');
}
function _pbCashflowRows(){
  const ms = _recentMonths(12);
  const incBy = {}, expBy = {};
  (DB.income   || []).forEach(i => { const ym=String(i.date||'').slice(0,7); if(ym) incBy[ym]=(incBy[ym]||0)+incomeNet(i); });
  (DB.expenses || []).forEach(x => { const ym=String(x.date||'').slice(0,7); if(!ym) return; const sgd = expenseAmountSgdOrNull(x); if (sgd != null) expBy[ym]=(expBy[ym]||0)+sgd; });
  return ms.map(m => { const inc=incBy[m]||0, exp=expBy[m]||0; return { month:m, income:inc, expense:exp, net:inc-exp }; });
}
function _pbRangeCutoff(rangeKey){
  if (!rangeKey || rangeKey === 'ALL') return null;
  const n = {ONE_MONTH:1, THREE_MONTHS:3, SIX_MONTHS:6, ONE_YEAR:12}[rangeKey];
  if (!n) return null;
  const d = new Date(); d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0,10);
}
function _pbNetWorthSeries(cfg){
  const snaps = (DB.snapshots||[]).slice().sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const cutoff = _pbRangeCutoff(cfg.range);
  const rows = cutoff ? snaps.filter(s => s.date >= cutoff) : snaps;
  const labels = rows.map(s => s.date);
  const cpfOf = s => (s.byClass && s.byClass.cpf) || 0;
  const netOf = s => _dashShowCpf ? s.net : (s.net - cpfOf(s));
  const classMeta = { stocks:['Stocks',0], cash:['Cash',1], cpf:['CPF',2], realestate:['Real Estate',3], crypto:['Crypto',4] };
  const dot = i => PB_PALETTE[i % PB_PALETTE.length];

  // By class — stacked area of every class (CPF band only when CPF is on).
  if (cfg.seriesMode === 'split'){
    return { labels, stacked:true, datasets: Object.entries(classMeta)
      .filter(([k]) => k !== 'cpf' || _dashShowCpf)
      .map(([k,[lab,i]]) => ({
        label:lab, data:rows.map(s=>toDisplay((s.byClass&&s.byClass[k])||0,'SGD')),
        borderColor:dot(i), backgroundColor:dot(i)+'44',
        fill:true, borderWidth:1.5, pointRadius:0, tension:0.25, stack:'nw'
      }))};
  }
  // Single class — isolate one class as its own line.
  if (cfg.seriesMode === 'single'){
    const k = classMeta[cfg.seriesClass] ? cfg.seriesClass : 'cash';
    if (k === 'cpf' && !_dashShowCpf) return { labels:[], datasets:[], hidden:true };
    const [lab,i] = classMeta[k];
    return { labels, stacked:false, datasets:[{
      label:lab, data:rows.map(s=>toDisplay((s.byClass&&s.byClass[k])||0,'SGD')),
      borderColor:dot(i), backgroundColor:'transparent',
      fill:false, borderWidth:2, pointRadius:rows.length>30?0:2, tension:0.25
    }]};
  }
  // With vs without CPF — two lines so the CPF contribution is the gap between.
  if (cfg.seriesMode === 'cpfCompare'){
    if (!_dashShowCpf) return { labels:[], datasets:[], hidden:true };
    return { labels, stacked:false, datasets:[
      { label:'With CPF', data:rows.map(s=>toDisplay(s.net,'SGD')),
        borderColor:_cssVar('--accent'), backgroundColor:'transparent', fill:false, borderWidth:2, pointRadius:rows.length>30?0:2, tension:0.25 },
      { label:'Ex-CPF', data:rows.map(s=>toDisplay(s.net - cpfOf(s),'SGD')),
        borderColor:dot(1), backgroundColor:'transparent', fill:false, borderWidth:2, borderDash:[5,4], pointRadius:rows.length>30?0:2, tension:0.25 }
    ]};
  }
  // Total — single net worth line, follows the dashboard CPF toggle.
  return { labels, stacked:false, datasets:[{
    label:_dashShowCpf?'Net worth':'Net worth (ex-CPF)',
    data:rows.map(s=>toDisplay(netOf(s),'SGD')),
    borderColor:_cssVar('--accent'), backgroundColor:'transparent',
    fill:false, borderWidth:2, pointRadius:rows.length>30?0:2, tension:0.25
  }]};
}

/* CPF balances over time, reconstructed monthly from the opening anchor +
   dated cpfHistory (no snapshots needed). Total = one line; split = OA/SA/MA/RA
   stacked area. Honours the dashboard CPF toggle: hidden when CPF is off. */
function _pbCpfSeries(cfg){
  if (!_dashShowCpf) return { labels:[], datasets:[], hidden:true };
  if (!_cpfAnchorDate()) return { labels:[], datasets:[], noAnchor:true };
  const cutoff = _pbRangeCutoff(cfg.range);
  const months = _cpfMonthEnds().filter(me => !cutoff || me >= cutoff);
  const labels = months.map(me => me.slice(0,7));     // YYYY-MM
  const bals = months.map(cpfBalancesAsOf);
  if (cfg.seriesMode === 'split'){
    const accDefs = [['OA','OA',0],['SA','SA',1],['MA','MA',2],['RA','RA',3]];
    return { labels, stacked:true, datasets: accDefs.map(([k,lab,i]) => ({
      label:lab, data:bals.map(b=>toDisplay(b[k]||0,'SGD')),
      borderColor:PB_PALETTE[i%PB_PALETTE.length], backgroundColor:PB_PALETTE[i%PB_PALETTE.length]+'44',
      fill:true, borderWidth:1.5, pointRadius:0, tension:0.25, stack:'cpf'
    }))};
  }
  return { labels, stacked:false, datasets:[{
    label:'CPF', data:bals.map(b=>toDisplay((b.OA||0)+(b.SA||0)+(b.MA||0)+(b.RA||0),'SGD')),
    borderColor:_cssVar('--accent'), backgroundColor:'transparent',
    fill:false, borderWidth:2, pointRadius:months.length>30?0:3, tension:0.25
  }]};
}

const PB_SOURCES = {
  holdings:   { key:'holdings',   label:'Holdings',   kind:'holdings',
                fields:PB_HOLDINGS_FIELDS, rows:() => _stockChartRows },
  allocation: { key:'allocation', label:'Allocation', kind:'crosssec',
                fields:PB_ALLOC_FIELDS,   rows:() => _pbAllocRows() },
  cashflow:   { key:'cashflow',   label:'Cashflow',   kind:'crosssec',
                fields:PB_CASHFLOW_FIELDS, rows:() => _pbCashflowRows() },
  networth:   { key:'networth',   label:'Net worth',  kind:'series',
                series:(cfg) => _pbNetWorthSeries(cfg) },
  cpf:        { key:'cpf',        label:'CPF',        kind:'series',
                series:(cfg) => _pbCpfSeries(cfg) },
};
function pbSource(cfg){ return PB_SOURCES[cfg&&cfg.source] || PB_SOURCES.holdings; }
function pbFields(cfg){ return pbSource(cfg).fields || {}; }

function _pbCurSym(){ const dc = displayCcy(); return dc === 'USD' ? 'US$' : dc === 'SGD' ? 'S$' : (dc + ' '); }
function _pbVal(raw, field){ return (field && field.unit === 'money') ? toDisplay(Number(raw)||0, 'SGD') : (Number(raw)||0); }
function _pbRows(){ return _stockChartRows || []; }
function _pbFilteredRows(kw){
  const rows = _pbRows();
  const term = (kw || '').toLowerCase().trim();
  if (!term) return rows;
  return rows.filter(r =>
    ((r.s.symbol||'') + ' ' + (r.s.market||'') + ' ' + (r.ccy||'') + ' ' + (r.s.sector||'')).toLowerCase().includes(term));
}

function _pbLoadState(){
  try{
    const raw = DB.settings.chartBuilder || null;
    if (raw && Array.isArray(raw.x) && Array.isArray(raw.y)){
      const srcKey = PB_SOURCES[raw.source] ? raw.source : 'holdings';
      const flds = PB_SOURCES[srcKey].fields || PB_HOLDINGS_FIELDS;
      return {
        source: srcKey,
        x: raw.x.filter(k => flds[k] && flds[k].type === 'dim'),
        y: raw.y.filter(k => flds[k] && flds[k].type === 'meas'),
        mode: raw.mode === 'timeseries' ? 'timeseries' : 'crosssec',
        range: PB_PERIODS[raw.range] ? raw.range : 'SIX_MONTHS',
        seriesMode: PB_SERIES_MODES.includes(raw.seriesMode) ? raw.seriesMode : (raw.nwMode === 'byClass' ? 'split' : 'total'),
        seriesClass: PB_CLASS_KEYS.includes(raw.seriesClass) ? raw.seriesClass : 'cash',
        tsValue: raw.tsValue === 'positionValue' ? 'positionValue' : 'price',
        tsAvgCost: !!raw.tsAvgCost,
        tsSymbols: Array.isArray(raw.tsSymbols) ? raw.tsSymbols : [],
        customItems: null
      };
    }
  }catch(e){}
  return { source:'holdings', x:[], y:[], mode:'crosssec', range:'SIX_MONTHS', seriesMode:'total', seriesClass:'cash', tsValue:'price', tsAvgCost:false, tsSymbols:[], customItems:null };
}
function _pbSaveState(){ DB.settings.chartBuilder = pbState; saveData(); }
// Parse-time default; migrateDeviceLocalChartState() reloads this from
// DB.settings once the real DB is in place (loadLocal() runs later, at boot).
let pbState = _pbLoadState();

/* ── Builder UI injection (once) ── */
function _pbEnsureUI(){
  const host = document.getElementById('stocks-builder');
  if (!host || host.dataset.ready) return;
  host.dataset.ready = '1';
  const rl = 'font-size:12px;color:var(--text3);text-transform:uppercase;letter-spacing:0.6px;font-weight:600';
  host.innerHTML = `
  <div class="card" style="margin-bottom:16px">
    <div class="card-head cb-builder-head">
      <h3><svg width="15" height="15" viewBox="0 0 15 15" fill="none" style="vertical-align:-2px;margin-right:5px"><rect x="1" y="8" width="3" height="6" rx="0.5" fill="currentColor"/><rect x="6" y="4" width="3" height="10" rx="0.5" fill="currentColor"/><rect x="11" y="1" width="3" height="13" rx="0.5" fill="currentColor"/></svg>Chart Builder</h3>
      <div class="cb-head-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select class="fi fi-sm" style="width:auto" id="pb-source-select" data-change="pbSetSource">
          <option value="holdings">Holdings</option>
          <option value="allocation">Allocation</option>
          <option value="cashflow">Cashflow</option>
          <option value="networth">Net worth</option>
          <option value="cpf">CPF</option>
        </select>
        <div id="pb-mode-btns" style="display:flex;gap:4px">
          <button class="cb-period-btn" id="pb-mode-crosssec" data-click="pbSetMode" data-a0="crosssec">By holding</button>
          <button class="cb-period-btn" id="pb-mode-timeseries" data-click="pbSetMode" data-a0="timeseries">Price history</button>
        </div>
        <select class="fi fi-sm" style="width:auto" id="pb-chart-type" data-change="pbRenderChart">
          <option value="bar">Bar</option><option value="line">Line</option>
          <option value="doughnut">Doughnut</option><option value="scatter">Scatter</option>
        </select>
        <button class="btn btn-sm btn-primary" data-click="pbSaveChart" id="pb-save-btn" disabled>＋ Add to Dashboard</button>
        <button class="btn btn-sm btn-ghost" data-click="pbResetChart">Reset</button>
      </div>
    </div>

    <div id="pb-layout" class="cb-layout" style="display:grid;grid-template-columns:220px 1fr;gap:0;min-height:380px">

      <!-- Left rail: field palette (crosssec) OR symbol controls (price history) OR series controls -->
      <div class="cb-palette-col" style="border-right:1px solid var(--border);padding:14px;display:flex;flex-direction:column;gap:8px">
        <div id="pb-palette-pane" style="display:flex;flex-direction:column;gap:8px">
          <div style="${rl}">Available Fields</div>
          <input id="pb-palette-search" class="fi fi-sm" placeholder="Search fields..." data-input="pbFilterPalette">
          <div id="pb-palette" style="display:flex;flex-direction:column;gap:5px"></div>
        </div>
        <div id="pb-ts-pane" style="display:none;flex-direction:column;gap:6px">
          <div style="${rl}">Symbols</div>
          <div id="pb-ts-symbols" style="display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto"></div>
          <div style="${rl};margin-top:8px">Value</div>
          <select class="fi fi-sm" id="pb-ts-value" data-change="pbSetTsValue">
            <option value="price">Close price</option><option value="positionValue">Position value</option>
          </select>
          <div style="${rl};margin-top:8px">Period</div>
          <div class="btns" id="pb-ts-periods" style="display:flex;gap:4px;flex-wrap:wrap"></div>
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;margin-top:8px"><input type="checkbox" id="pb-ts-avgcost" data-change="pbToggleAvgCost"> Show avg cost</label>
        </div>
        <div id="pb-series-controls" style="display:none;flex-direction:column;gap:6px">
          <div style="${rl}">Period</div>
          <div class="btns" id="pb-series-periods" style="display:flex;gap:4px;flex-wrap:wrap"></div>
          <div style="${rl};margin-top:8px">View</div>
          <select class="fi fi-sm" id="pb-series-view" data-change="pbSetSeriesView"></select>
          <div id="pb-series-class-wrap" style="display:none;flex-direction:column;gap:6px">
            <div style="${rl};margin-top:4px">Class</div>
            <select class="fi fi-sm" id="pb-series-class" data-change="pbSetSeriesClass">
              <option value="stocks">Stocks</option>
              <option value="cash">Cash</option>
              <option value="cpf">CPF</option>
              <option value="realestate">Real Estate</option>
              <option value="crypto">Crypto</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Right: cross-sectional axes/controls (above) + shared chart (fills) -->
      <div style="display:flex;flex-direction:column;min-width:0">
        <div id="pb-crosssec-controls">
          <div class="cb-axes-row" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:14px;border-bottom:1px solid var(--border)">
            <div>
              <div style="${rl};margin-bottom:5px">Group by (X)</div>
              <div id="pb-drop-x" class="cb-drop-zone cb-multi-zone" data-drop="x">
                <div id="pb-x-chips" style="display:flex;flex-wrap:wrap;gap:4px;width:100%"></div>
                <span id="pb-x-placeholder" class="cb-drop-label">Tap or drag a dimension</span>
              </div>
            </div>
            <div>
              <div style="${rl};margin-bottom:5px">Measure (Y)</div>
              <div id="pb-drop-y" class="cb-drop-zone cb-multi-zone" data-drop="y">
                <div id="pb-y-chips" style="display:flex;flex-wrap:wrap;gap:4px;width:100%"></div>
                <span id="pb-y-placeholder" class="cb-drop-label">Tap or drag a measure</span>
              </div>
            </div>
            <div>
              <div style="${rl};margin-bottom:5px">Filter</div>
              <input id="pb-kw" class="cb-drop-zone" style="font-size:12px;width:100%;min-height:42px;padding:11px 12px" placeholder="symbol / sector…" data-input="pbRenderChart">
            </div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;padding:8px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap">
            <span style="font-size:12px;color:var(--text3)">Top N:</span>
            <select class="fi fi-sm" id="pb-topn" data-change="pbRenderChart" style="width:auto">
              <option value="all" selected>All</option><option value="5">5</option><option value="10">10</option><option value="20">20</option>
            </select>
            <span style="font-size:12px;color:var(--text3)">Sort:</span>
            <select class="fi fi-sm" id="pb-sort" data-change="pbRenderChart" style="width:auto">
              <option value="desc">Highest first</option><option value="asc">Lowest first</option><option value="alpha">A → Z</option>
            </select>
            <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer"><input type="checkbox" id="pb-dual" data-change="pbRenderChart"> Dual axis</label>
          </div>
        </div>

        <div style="padding:14px;flex:1;min-height:300px;position:relative;display:flex;flex-direction:column">
          <div id="pb-empty" class="empty" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:260px">
            <div class="empty-title">Build a chart</div>
            <div class="empty-sub">Pick a source and fields, or switch to Price history.</div>
          </div>
          <div id="pb-chart-wrap" style="display:none;flex:1;min-height:320px;position:relative"><canvas id="pb-live-canvas"></canvas></div>
          <div id="pb-summary" style="font-size:12px;color:var(--text3);margin-top:8px;display:flex;gap:14px;flex-wrap:wrap"></div>
        </div>
      </div>
    </div>
  </div>`;

  // Period buttons for price-history rail (no ALL)
  const pBox = document.getElementById('pb-ts-periods');
  if (pBox) pBox.innerHTML = ['ONE_MONTH','THREE_MONTHS','SIX_MONTHS','ONE_YEAR'].map(k =>
    `<button class="cb-period-btn" data-period="${k}" data-click="pbSetPeriod" data-a0="${k}">${PB_PERIOD_LABELS[k]}</button>`).join('');
  // Period buttons for the series rail (net worth / CPF, includes All)
  const seriesBox = document.getElementById('pb-series-periods');
  if (seriesBox) seriesBox.innerHTML = Object.keys(PB_PERIODS).map(k =>
    `<button class="cb-period-btn" data-period="${k}" data-click="pbSetPeriod" data-a0="${k}">${PB_PERIOD_LABELS[k]}</button>`).join('');
}

/* ── Entry point ── */
function renderChartBuilder(){
  buildStockChartRows();
  setRenderCcy('dashboard');
  _pbEnsureUI();
  pbSeedDefaults();
  // Restore control values from state
  const ss = document.getElementById('pb-source-select'); if (ss) ss.value = pbState.source || 'holdings';
  const tv = document.getElementById('pb-ts-value'); if (tv) tv.value = pbState.tsValue;
  const ac = document.getElementById('pb-ts-avgcost'); if (ac) ac.checked = pbState.tsAvgCost;
  _pbApplyModeUI();
  pbInitPalette();
  pbRenderChips('x'); pbRenderChips('y');
  _pbRenderSymbolList();
  _pbMarkPeriodBtns();
  pbRenderChart();
  pbRenderAllSaved();
}

/* View options per series source. */
function _pbSeriesViewOpts(srcKey){
  return srcKey === 'cpf'
    ? [['total','Total'],['split','By account']]
    : [['total','Total'],['split','By class'],['single','Single class'],['cpfCompare','With vs without CPF']];
}
/* Short label for a series chart's view, used in the saved-card meta line. */
function _pbSeriesViewLabel(cfg, src){
  if (cfg.seriesMode === 'split') return src.key === 'cpf' ? 'by account' : 'by class';
  if (cfg.seriesMode === 'single') return (PB_CLASS_LABELS[cfg.seriesClass] || 'class').toLowerCase();
  if (cfg.seriesMode === 'cpfCompare') return 'with vs without CPF';
  return 'total';
}

function _pbApplyModeUI(){
  const src = pbSource(pbState);
  const palettePane = document.getElementById('pb-palette-pane');
  const tsPane      = document.getElementById('pb-ts-pane');
  const csControls  = document.getElementById('pb-crosssec-controls');
  const ctype       = document.getElementById('pb-chart-type');
  const modeBtns    = document.getElementById('pb-mode-btns');
  const seriesControls = document.getElementById('pb-series-controls');
  if (!palettePane) return;
  if (src.kind === 'series'){
    palettePane.style.display = 'none';
    if (tsPane)     tsPane.style.display     = 'none';
    if (csControls) csControls.style.display = 'none';
    if (ctype)      ctype.style.display      = 'none';
    if (modeBtns)   modeBtns.style.display   = 'none';
    if (seriesControls) seriesControls.style.display = 'flex';
    // View options are source-specific; reset to Total if the current view
    // isn't valid for this source (e.g. cpfCompare after switching to CPF).
    const viewSel = document.getElementById('pb-series-view');
    if (viewSel){
      const opts = _pbSeriesViewOpts(src.key);
      viewSel.innerHTML = opts.map(([v,l]) => `<option value="${v}">${l}</option>`).join('');
      if (!opts.some(([v]) => v === pbState.seriesMode)) pbState.seriesMode = 'total';
      viewSel.value = pbState.seriesMode;
    }
    const classWrap = document.getElementById('pb-series-class-wrap');
    if (classWrap) classWrap.style.display = (src.key === 'networth' && pbState.seriesMode === 'single') ? 'flex' : 'none';
    const classSel = document.getElementById('pb-series-class');
    if (classSel) classSel.value = pbState.seriesClass || 'cash';
    pbState.mode = 'crosssec';
  } else if (src.kind === 'crosssec'){
    palettePane.style.display = 'flex';
    if (tsPane)     tsPane.style.display     = 'none';
    if (csControls) csControls.style.display = '';
    if (ctype)      ctype.style.display      = '';
    if (modeBtns)   modeBtns.style.display   = 'none';
    if (seriesControls) seriesControls.style.display = 'none';
    pbState.mode = 'crosssec';
  } else {
    // holdings — show/hide based on crosssec vs timeseries mode
    const isTs = pbState.mode === 'timeseries';
    palettePane.style.display = isTs ? 'none' : 'flex';
    if (tsPane)     tsPane.style.display     = isTs ? 'flex' : 'none';
    if (csControls) csControls.style.display = isTs ? 'none' : '';
    if (ctype)      ctype.style.display      = isTs ? 'none' : '';
    if (modeBtns)   modeBtns.style.display   = '';
    if (seriesControls) seriesControls.style.display = 'none';
    const mcs = document.getElementById('pb-mode-crosssec');   if (mcs)  mcs.classList.toggle('active', !isTs);
    const mts = document.getElementById('pb-mode-timeseries'); if (mts) mts.classList.toggle('active', isTs);
  }
}

function pbSetMode(mode){
  pbState.mode = mode === 'timeseries' ? 'timeseries' : 'crosssec';
  _pbSaveState();
  _pbApplyModeUI();
  pbRenderChart();
}

function pbSetPeriod(k){
  if (!PB_PERIODS[k]) return;
  pbState.range = k; _pbSaveState();
  _pbMarkPeriodBtns();
  pbRenderChart();
}
function _pbMarkPeriodBtns(){
  document.querySelectorAll('#pb-ts-periods .cb-period-btn, #pb-series-periods .cb-period-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.period === pbState.range));
}

/* ── Palette (cross-sectional) ── */
function pbInitPalette(){
  const palette = document.getElementById('pb-palette');
  if (!palette) return;
  const flds = pbFields(pbState);
  const groups = [
    ['Dimensions (Group by)', Object.entries(flds).filter(([,f]) => f.type === 'dim')],
    ['Measures (Values)',     Object.entries(flds).filter(([,f]) => f.type === 'meas')]
  ];
  palette.innerHTML = groups.map(([heading, fields]) =>
    `<div style="font-size:12px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin-top:8px">${heading}</div>` +
    fields.map(([key, f]) =>
      `<div class="cb-field-pill" draggable="true" data-field="${key}" data-label="${kjrEscape(f.label)}"
            data-drag-key="${key}" data-click="pbAssignField" data-a0="${key}">
        <span>${f.label}</span>
        <span class="pill-type">${f.type === 'dim' ? 'Group' : 'Value'}</span>
      </div>`).join('')
  ).join('');
}
function pbFilterPalette(q){
  document.querySelectorAll('#pb-palette .cb-field-pill').forEach(el => {
    el.style.display = q && !el.dataset.label.toLowerCase().includes(q.toLowerCase()) ? 'none' : '';
  });
}
/* pbDrop now receives the resolved axis + dragged key from the delegated drop
   listener in installEventDelegation (drag-over styling is handled there too). */
function pbDrop(axis, key){
  const f = pbFields(pbState)[key];
  if (!f) return;
  if (axis === 'x' && f.type !== 'dim'){ showToast('"' + f.label + '" is a measure — drop it on Y'); return; }
  if (axis === 'y' && f.type !== 'meas'){ showToast('"' + f.label + '" is a dimension — drop it on X'); return; }
  _pbCommitField(key, axis);
}
function pbAssignField(key){
  const f = pbFields(pbState)[key];
  if (!f) return;
  _pbCommitField(key, f.type === 'dim' ? 'x' : 'y');
}
function _pbCommitField(key, axis){
  if (!pbState[axis].includes(key)){
    pbState[axis].push(key);
    _pbSaveState();
    pbRenderChips(axis);
    pbRenderChart();
  }
}
function pbRemoveField(axis, key){
  pbState[axis] = pbState[axis].filter(k => k !== key);
  _pbSaveState();
  pbRenderChips(axis);
  pbRenderChart();
}
function pbRenderChips(axis){
  const chipsEl = document.getElementById('pb-' + axis + '-chips');
  const ph = document.getElementById('pb-' + axis + '-placeholder');
  if (!chipsEl) return;
  const flds = pbFields(pbState);
  chipsEl.innerHTML = pbState[axis].map(key => {
    const f = flds[key] || { label:'(?) ' + key };
    return `<span class="cb-axis-chip">${f.label}<button data-click="pbRemoveField" data-a0="${axis}" data-a1="${key}" title="Remove">×</button></span>`;
  }).join('');
  if (ph) ph.style.display = pbState[axis].length ? 'none' : '';
}

/* ── Time-series symbol list ── */
function _pbStockRows(){ return _pbRows().filter(r => r.s && r.s.market); }
function _pbRenderSymbolList(){
  const box = document.getElementById('pb-ts-symbols');
  if (!box) return;
  const rows = _pbStockRows();
  if (!rows.length){ box.innerHTML = '<div style="font-size:12px;color:var(--text3)">No holdings</div>'; return; }
  // Default selection = all symbols when none chosen yet
  if (!pbState.tsSymbols || !pbState.tsSymbols.length) pbState.tsSymbols = rows.map(r => r.ysym);
  box.innerHTML = rows.map(r => {
    const checked = pbState.tsSymbols.includes(r.ysym) ? 'checked' : '';
    return `<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
      <input type="checkbox" value="${kjrEscape(r.ysym)}" ${checked} data-change="pbToggleSymbol"> ${kjrEscape(r.s.symbol)}</label>`;
  }).join('');
}
function pbToggleSymbol(ysym, on){
  const set = new Set(pbState.tsSymbols || []);
  if (on) set.add(ysym); else set.delete(ysym);
  pbState.tsSymbols = [...set];
  _pbSaveState();
  pbRenderChart();
}

/* ── Live config + render dispatch ── */
function _pbLiveConfig(){
  return {
    source: pbState.source || 'holdings',
    mode: pbState.mode,
    seriesMode: pbState.seriesMode || 'total',
    seriesClass: pbState.seriesClass || 'cash',
    xFields: [...pbState.x], yFields: [...pbState.y],
    chartType: (document.getElementById('pb-chart-type')||{}).value || 'bar',
    topN: (document.getElementById('pb-topn')||{}).value || 'all',
    sort: (document.getElementById('pb-sort')||{}).value || 'desc',
    dualAxis: !!(document.getElementById('pb-dual')||{}).checked,
    kwFilter: (document.getElementById('pb-kw')||{}).value || '',
    range: pbState.range, tsSymbols: [...(pbState.tsSymbols||[])],
    tsValue: pbState.tsValue, tsAvgCost: pbState.tsAvgCost
  };
}
function pbRenderChart(){
  const cfg = _pbLiveConfig();
  const host = { canvasId:'pb-live-canvas', wrapEl: document.getElementById('pb-chart-wrap'),
                 emptyEl: document.getElementById('pb-empty'), summaryEl: document.getElementById('pb-summary') };
  const saveBtn = document.getElementById('pb-save-btn');
  _pbDrawInto(host, cfg).then(ok => { if (saveBtn) saveBtn.disabled = !ok; });
}

/* Toggle empty/chart, draw, return whether a chart rendered. */
function _pbDrawInto(host, cfg){
  const showEmpty = (title, sub) => {
    if (host.wrapEl) host.wrapEl.style.display = 'none';
    if (host.emptyEl){
      host.emptyEl.style.display = 'flex';
      if (title) host.emptyEl.innerHTML = `<div class="empty-title">${title}</div><div class="empty-sub">${sub||''}</div>`;
    }
    if (host.summaryEl) host.summaryEl.innerHTML = '';
    const inst = _pbCharts[host.canvasId]; if (inst){ try{ inst.destroy(); }catch(e){} delete _pbCharts[host.canvasId]; }
  };
  const showChart = () => { if (host.emptyEl) host.emptyEl.style.display = 'none'; if (host.wrapEl) host.wrapEl.style.display = 'block'; };

  const src = pbSource(cfg);
  if (src.kind === 'series') return Promise.resolve(_pbDrawInternalSeries(host, cfg, showEmpty, showChart));
  if (cfg.mode === 'timeseries' && src.kind === 'holdings') return _pbDrawTimeSeries(host, cfg, showEmpty, showChart);
  return Promise.resolve(_pbDrawCrossSectional(host, cfg, showEmpty, showChart));
}

/* ── Cross-sectional draw ── */
function _pbDrawCrossSectional(host, cfg, showEmpty, showChart){
  const src = pbSource(cfg);
  const flds = pbFields(cfg);
  if (!cfg.xFields.length || !cfg.yFields.length){
    const sub = src.kind === 'holdings' ? 'Pick a dimension and a measure, or switch to Price history.' : 'Select a dimension and a measure.';
    showEmpty('Build a chart', sub); return false;
  }
  const rows = src.kind === 'holdings' ? _pbFilteredRows(cfg.kwFilter) : (src.rows ? src.rows() : []);
  if (!rows.length){
    const msg = src.key === 'allocation'
      ? ['No assets yet',        'Add stocks, cash, or CPF to see your allocation.']
      : src.key === 'cashflow'
      ? ['No transactions yet',  'Add income or expenses to see your cashflow.']
      : ['No matching holdings', 'Clear the filter to see your positions.'];
    showEmpty(...msg); return false;
  }
  const entries = kjrChartAggregate(rows, cfg.xFields, cfg.yFields, flds, cfg.sort, cfg.topN);
  if (!entries.length){ showEmpty('Nothing to plot', 'No groups for this configuration.'); return false; }

  const curSym = _pbCurSym();
  const isRound = cfg.chartType === 'doughnut' || cfg.chartType === 'pie';
  const labels = entries.map(([k]) => k.length > 28 ? k.slice(0,28)+'…' : k);
  const datasets = cfg.yFields.map((yKey, yi) => {
    const f = flds[yKey];
    const color = PB_PALETTE[yi % PB_PALETTE.length];
    const values = entries.map(([,v]) => +(_pbVal(v[yKey]||0, f)).toFixed(2));
    const ds = {
      label: f.label, data: values,
      backgroundColor: isRound ? entries.map((_,i) => PB_PALETTE[i % PB_PALETTE.length]) : color + '55',
      borderColor: isRound ? _cssVar('--bg2') : color,
      borderWidth: isRound ? 2 : 1.5,
      borderRadius: cfg.chartType === 'bar' ? 4 : 0,
      fill: cfg.chartType === 'line', tension: 0.3,
      pointRadius: cfg.chartType === 'line' ? 4 : 0
    };
    if (cfg.dualAxis && yi === 1) ds.yAxisID = 'y2';
    return ds;
  });

  showChart();
  const axisColor = _cssVar('--text3'), gridColor = _cssVar('--border');
  const yK1 = cfg.yFields[0], yK2 = cfg.yFields[1];
  const scales = isRound ? {} : {
    x: { ticks:{ color:axisColor, font:{size:10}, maxRotation:40 }, grid:{ display:false } },
    y: { ticks:{ color:axisColor, font:{size:10}, callback:v => kjrFmtAxis(v, flds[yK1], curSym) }, grid:{ color:gridColor },
         title:{ display:true, text:flds[yK1]?.label||'', color:axisColor, font:{size:10} } }
  };
  if (cfg.dualAxis && cfg.yFields.length > 1){
    scales.y2 = { position:'right', grid:{ display:false },
      ticks:{ color:PB_PALETTE[1], font:{size:10}, callback:v => kjrFmtAxis(v, flds[yK2], curSym) },
      title:{ display:true, text:flds[yK2]?.label||'', color:PB_PALETTE[1], font:{size:10} } };
  }
  _pbMountChart(host.canvasId, {
    type: cfg.chartType, data:{ labels, datasets },
    options:{ responsive:true, maintainAspectRatio:false, animation:{duration:300}, interaction:{mode:'index',intersect:false},
      plugins:{ legend:{ display: datasets.length>1 || isRound, position: isRound?'bottom':'top', labels:{ color:_cssVar('--text2'), font:{size:11}, padding:12, usePointStyle:true } },
        tooltip:{ callbacks:{ label: t => {
          const yKey = cfg.yFields[t.datasetIndex] || cfg.yFields[0];
          const raw = (t.parsed && typeof t.parsed.y === 'number') ? t.parsed.y : t.parsed;
          return ' ' + t.dataset.label + ': ' + kjrFmtMeasure(raw, flds[yKey], curSym);
        } } } },
      scales }
  });

  if (host.summaryEl){
    const itemLabel = src.kind === 'holdings' ? 'holdings' : 'items';
    const parts = cfg.yFields.map((yKey, yi) => {
      const f = flds[yKey] || { label:yKey };
      const vals = entries.map(([,v]) => _pbVal(v[yKey]||0, f));
      const tot = vals.reduce((s,v)=>s+v,0), avg = vals.length?tot/vals.length:0;
      const mx = vals.length?Math.max(...vals):0, mn = vals.length?Math.min(...vals):0;
      // Wrapped in .money-chip so privacy mode blurs these totals too.
      const fm = v => `<span class="money-chip">${kjrFmtMeasure(v, f, curSym)}</span>`;
      return `<span><strong style="color:${PB_PALETTE[yi%PB_PALETTE.length]}">${f.label}</strong>` +
             (f.agg === 'avg' ? '' : ` · Total: ${fm(tot)}`) + ` · Avg: ${fm(avg)} · Min: ${fm(mn)} · Max: ${fm(mx)}</span>`;
    });
    host.summaryEl.innerHTML = `<span style="color:var(--text3)">${entries.length} groups · ${rows.length} ${itemLabel}</span>` + parts.join('');
  }
  return true;
}

/* ── Time-series draw ── */
async function _pbDrawTimeSeries(host, cfg, showEmpty, showChart){
  const rows = _pbStockRows();
  const chosen = (cfg.tsSymbols && cfg.tsSymbols.length) ? rows.filter(r => cfg.tsSymbols.includes(r.ysym)) : rows;
  if (!chosen.length){ showEmpty('Pick a symbol', 'Tick one or more holdings to chart their price history.'); return false; }
  if (!getSyncUrl()){ showEmpty('Backend needed', 'Set the Apps Script URL in Settings, then Refresh prices, to load history.'); return false; }

  if (host.summaryEl) host.summaryEl.innerHTML = '<span style="color:var(--text3)">Loading price history…</span>';
  let hist = {};
  try { hist = await fetchStockHistory(chosen.map(r => r.ysym), cfg.range); }
  catch(e){ showEmpty('History unavailable', 'Could not load price history. Try again after a price refresh.'); return false; }

  const curSym = _pbCurSym();
  const dropped = [];
  // Build a per-symbol date→value map, then plot every series against one
  // shared, sorted date axis. SGX and US trade on different days, so aligning
  // by date (not array index) is the only way the lines line up. Missing days
  // become gaps that spanGaps joins across. p.t is a ms epoch — format it to a
  // YYYY-MM-DD label (a raw slice of the number is not a date).
  const series = [];
  chosen.forEach((r, i) => {
    const h = hist[r.ysym];
    if (!h || !h.points || !h.points.length){ dropped.push(r.s.symbol); return; }
    const pxCcy = h.ccy || r.priceCcy || r.ccy;
    const map = {};
    h.points.forEach(p => {
      const t = Number(p.t); if (!isFinite(t)) return;
      const d = new Date(t).toISOString().slice(0,10);
      const base = cfg.tsValue === 'positionValue' ? (p.c * (r.shares||0)) : p.c;
      map[d] = +toDisplay(base, pxCcy).toFixed(2);
    });
    if (Object.keys(map).length) series.push({ r, i, map }); else dropped.push(r.s.symbol);
  });
  if (!series.length){ showEmpty('History unavailable', 'No price history returned for the selected symbols.'); return false; }

  const labels = [...new Set(series.flatMap(s => Object.keys(s.map)))].sort();
  const datasets = [];
  series.forEach(({ r, i, map }) => {
    const color = PB_PALETTE[i % PB_PALETTE.length];
    datasets.push({ label:r.s.symbol, data: labels.map(d => d in map ? map[d] : null), spanGaps:true,
                    borderColor:color, backgroundColor:'transparent', borderWidth:2, pointRadius:0, tension:0.15 });
    if (cfg.tsAvgCost && r.avgCost){
      const ac = cfg.tsValue === 'positionValue' ? r.avgCost * (r.shares||0) : r.avgCost;
      const acVal = +toDisplay(ac, r.ccy).toFixed(2);
      // Avg-cost reference line only spans the dates where this symbol has data.
      datasets.push({ label:r.s.symbol + ' avg cost', data: labels.map(d => d in map ? acVal : null), spanGaps:true,
                      borderColor:color, borderDash:[6,4], borderWidth:1, pointRadius:0, _avgCost:true });
    }
  });

  showChart();
  const axisColor = _cssVar('--text3'), gridColor = _cssVar('--border');
  _pbMountChart(host.canvasId, {
    type:'line', data:{ labels, datasets },
    options:{ responsive:true, maintainAspectRatio:false, animation:{duration:300}, interaction:{mode:'index',intersect:false},
      plugins:{ legend:{ position:'top', labels:{ color:_cssVar('--text2'), font:{size:11}, padding:10, usePointStyle:true,
                  filter: it => !/ avg cost$/.test(it.text) } },
        tooltip:{ callbacks:{ label: t => ' ' + t.dataset.label + ': ' + curSym + (Number(t.parsed.y)||0).toLocaleString('en-SG',{maximumFractionDigits:2}) } } },
      scales:{ x:{ ticks:{ color:axisColor, font:{size:10}, maxTicksLimit:8 }, grid:{ display:false } },
               y:{ ticks:{ color:axisColor, font:{size:10}, callback:v => curSym + kjrFmtAxis(v, {unit:'count'}, curSym) }, grid:{ color:gridColor } } }
    }
  });
  if (host.summaryEl){
    const note = dropped.length ? ` · <span style="color:var(--amber,#f59e0b)">no data: ${dropped.map(kjrEscape).join(', ')}</span>` : '';
    host.summaryEl.innerHTML = `<span style="color:var(--text3)">${datasets.filter(d=>!d._avgCost).length} symbols · ${PB_PERIOD_LABELS[cfg.range]} · ${cfg.tsValue==='positionValue'?'position value':'close price'}${note}</span>`;
  }
  return true;
}

/* ── Internal time-series draw (net worth from snapshots, CPF reconstructed) ── */
function _pbDrawInternalSeries(host, cfg, showEmpty, showChart){
  const src = pbSource(cfg);
  const ser = src.series ? src.series(cfg) : { labels:[], datasets:[] };
  const isCpf = src.key === 'cpf';
  if (ser.hidden){ showEmpty('CPF is hidden', 'Turn CPF on at the top of the dashboard to view this chart.'); return false; }
  if (ser.noAnchor){ showEmpty('No CPF balances yet', 'Set your CPF starting balances in Settings to chart the trend.'); return false; }
  if (!ser.labels.length){
    if (isCpf){ showEmpty('No CPF history yet', 'CPF balances build up monthly. Come back after your next contribution.'); return false; }
    showEmpty('No history yet', 'Net worth is recorded daily. Come back after your first full day of usage.'); return false;
  }
  if (ser.labels.length < 2){
    if (isCpf){ showEmpty('Need 2+ months of history', 'Only one month recorded so far. The trend appears as it builds.'); return false; }
    showEmpty('Need 2+ days of history', 'One data point recorded so far. Come back tomorrow for the first chart.'); return false;
  }
  showChart();
  const axisColor = _cssVar('--text3'), gridColor = _cssVar('--border');
  _pbMountChart(host.canvasId, {
    type: 'line', data: { labels: ser.labels, datasets: ser.datasets },
    options: {
      responsive:true, maintainAspectRatio:false, animation:{duration:300},
      interaction:{ mode:'index', intersect:false },
      plugins:{
        legend:{ display: ser.stacked || ser.datasets.length > 1, position:'bottom', labels:{ color:_cssVar('--text2'), font:{size:11}, boxWidth:12, padding:12 } },
        tooltip:{ callbacks:{ label: c => ' ' + c.dataset.label + ': ' + fmt(c.parsed.y, { noConvert:true, dp:0 }) } }
      },
      scales:{
        x:{ stacked:ser.stacked, ticks:{ color:axisColor, font:{size:10}, maxTicksLimit:6 }, grid:{ display:false } },
        y:{ stacked:ser.stacked, ticks:{ color:axisColor, font:{size:10} }, grid:{ color:gridColor } }
      }
    }
  });
  if (host.summaryEl){
    const rangeLabel = PB_PERIOD_LABELS[cfg.range] || 'All time';
    const unit = isCpf ? 'months' : 'days';
    host.summaryEl.innerHTML = `<span style="color:var(--text3)">${ser.labels.length} ${unit} · ${rangeLabel}</span>`;
  }
  return true;
}

function _pbMountChart(canvasId, spec){
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const old = _pbCharts[canvasId]; if (old){ try{ old.destroy(); }catch(e){} }
  _pbCharts[canvasId] = new Chart(canvas.getContext('2d'), spec);
}

/* ── History fetch (memory cached, routes through the Apps Script proxy) ── */
async function fetchStockHistory(ysyms, range){
  const rangeParam = PB_PERIODS[range] || '6mo';
  const need = ysyms.filter(s => {
    const c = _pbHistCache[s] && _pbHistCache[s][range];
    return !c || isStale(c.fetchedAt, 12);
  });
  if (need.length && getSyncUrl()){
    const base = getSyncUrl();
    const url = base + (base.includes('?') ? '&' : '?') + 'action=history&symbols=' +
                encodeURIComponent(need.join(',')) + '&range=' + rangeParam;
    const resp = await fetch(url, { method:'GET', mode:'cors', redirect:'follow' });
    const data = await resp.json();
    if (data.error && !data.history) throw new Error(data.error);
    const now = new Date().toISOString();
    Object.entries(data.history || {}).forEach(([sym, h]) => {
      if (!h || h.error) return;
      if (!_pbHistCache[sym]) _pbHistCache[sym] = {};
      _pbHistCache[sym][range] = { ccy: h.ccy, points: h.points || [], fetchedAt: now };
    });
  }
  const out = {};
  ysyms.forEach(s => { const c = _pbHistCache[s] && _pbHistCache[s][range]; if (c) out[s] = c; });
  return out;
}

function pbResetChart(){
  pbState.x = []; pbState.y = []; pbState.customItems = null;
  _pbSaveState();
  pbRenderChips('x'); pbRenderChips('y');
  const kw = document.getElementById('pb-kw'); if (kw) kw.value = '';
  pbRenderChart();
}

/* ═══════ SAVED CHARTS ═══════
   DB.settings.savedCharts: null = never seeded (pbSeedDefaults will seed the
   3 built-in charts once), [] = user deliberately deleted every chart (never
   re-seed), array = the charts. pbLoadSaved() always returns an array for
   callers that iterate; pbSeedDefaults() reads the raw field directly so it
   can tell "never seeded" apart from "deliberately empty". */
function pbLoadSaved(){
  const raw = Array.isArray(DB.settings.savedCharts) ? DB.settings.savedCharts : [];
  const result = raw.filter(c => c && typeof c === 'object').map(c => {
    const srcKey = PB_SOURCES[c.source] ? c.source : 'holdings';
    const flds = pbFields({ source: srcKey });
    const mode = c.mode === 'timeseries' ? 'timeseries' : 'crosssec';
    return {
      id: c.id || ('sc_' + Date.now() + '_' + Math.random().toString(36).slice(2,6)),
      title: typeof c.title === 'string' ? c.title : 'Chart',
      source: srcKey,
      mode,
      seriesMode: PB_SERIES_MODES.includes(c.seriesMode) ? c.seriesMode : (c.nwMode === 'byClass' ? 'split' : 'total'),
      seriesClass: PB_CLASS_KEYS.includes(c.seriesClass) ? c.seriesClass : 'cash',
      xFields: Array.isArray(c.xFields) ? c.xFields.filter(k => flds[k] && flds[k].type==='dim') : [],
      yFields: Array.isArray(c.yFields) ? c.yFields.filter(k => flds[k] && flds[k].type==='meas') : [],
      chartType: ['bar','line','doughnut','scatter'].includes(c.chartType) ? c.chartType : 'bar',
      topN: ['all','5','10','20'].includes(String(c.topN)) ? String(c.topN) : 'all',
      sort: ['desc','asc','alpha'].includes(c.sort) ? c.sort : 'desc',
      dualAxis: !!c.dualAxis,
      kwFilter: typeof c.kwFilter === 'string' ? c.kwFilter : '',
      range: PB_PERIODS[c.range] ? c.range : 'SIX_MONTHS',
      tsSymbols: Array.isArray(c.tsSymbols) ? c.tsSymbols : [],
      tsValue: c.tsValue === 'positionValue' ? 'positionValue' : 'price',
      tsAvgCost: !!c.tsAvgCost,
      pinned: !!c.pinned,
      order: typeof c.order === 'number' ? c.order : 999,
    };
  }).filter(c => {
    const src = pbSource(c);
    if (src.kind === 'series') return true;
    if (c.mode === 'timeseries') return true;
    return c.xFields.length && c.yFields.length;
  });
  return result.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}
function pbPersistSaved(charts){ DB.settings.savedCharts = Array.isArray(charts) ? charts : []; saveData(); }

function pbSaveChart(){
  const cfg = _pbLiveConfig();
  const src = pbSource(cfg);
  const ready = src.kind === 'series'
    ? true
    : cfg.mode === 'timeseries' ? (cfg.tsSymbols.length > 0) : (cfg.xFields.length && cfg.yFields.length);
  if (!ready){ showToast('Build a chart first'); return; }
  const flds = pbFields(cfg);
  const defTitle = src.kind === 'series'
    ? (src.key === 'cpf'
        ? (cfg.seriesMode === 'split' ? 'CPF by account' : 'CPF over time')
        : cfg.seriesMode === 'split'      ? 'Net worth by class'
        : cfg.seriesMode === 'single'     ? (PB_CLASS_LABELS[cfg.seriesClass] || 'Class') + ' over time'
        : cfg.seriesMode === 'cpfCompare' ? 'Net worth: with vs without CPF'
        : 'Net worth over time')
    : cfg.mode === 'timeseries'
    ? 'Price history · ' + PB_PERIOD_LABELS[cfg.range]
    : cfg.xFields.map(k => flds[k]?.label).join(' + ') + ' vs ' + cfg.yFields.map(k => flds[k]?.label).join(' + ');
  const title = prompt('Name this chart:', defTitle);
  if (title === null) return;
  const charts = pbLoadSaved();
  charts.push(Object.assign({ id:'sc_' + Date.now(), title: title || 'Chart', pinned:false, order:999 }, cfg));
  pbPersistSaved(charts);
  pbRenderAllSaved();
  showToast('Chart added to dashboard', 'success');
}

function pbRenderAllSaved(){
  const stack = document.getElementById('dash-stack');
  if (!stack) return;
  // Remove only chart cards, never wipe the fixed blocks.
  stack.querySelectorAll(':scope > [data-wid^="chart:"]').forEach(el => el.remove());
  const charts = pbLoadSaved();
  charts.forEach(cfg => _pbRenderOneSaved(cfg));
  _applyDashLayout();
}
function _pbRenderOneSaved(cfg){
  const stack = document.getElementById('dash-stack');
  if (!stack) return;
  const wrap = document.createElement('div');
  wrap.className = 'saved-chart-card card';
  wrap.id = 'pb-sc-' + cfg.id;
  wrap.setAttribute('data-wid', 'chart:' + cfg.id);
  const src = pbSource(cfg);
  const flds = pbFields(cfg);
  const meta = src.kind === 'series'
    ? `${src.key === 'cpf' ? 'CPF' : 'Net worth'} · ${_pbSeriesViewLabel(cfg, src)} · ${PB_PERIOD_LABELS[cfg.range] || 'all time'}`
    : cfg.mode === 'timeseries'
    ? `Price history · ${PB_PERIOD_LABELS[cfg.range]} · ${cfg.tsValue==='positionValue'?'Position value':'Close price'}`
    : `X: ${cfg.xFields.map(k=>flds[k]?.label||k).join(' · ')} · Y: ${cfg.yFields.map(k=>flds[k]?.label||k).join(' · ')} · Top ${cfg.topN} · ${cfg.chartType}`;
  wrap.innerHTML = `
    <div class="card-head" style="flex-direction:column;align-items:flex-start;gap:4px">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center">
        <h3 style="font-size:14px">${kjrEscape(cfg.title)}</h3>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="btn btn-sm btn-ghost" data-click="pbTogglePin" data-a0="${cfg.id}">${cfg.pinned ? 'Pinned' : 'Pin'}</button>
          <button class="btn btn-sm btn-ghost" data-click="pbRefreshSaved" data-a0="${cfg.id}">↻</button>
          ${cfg.pinned?'':`<button class="btn btn-sm btn-ghost" data-click="pbDeleteSaved" data-a0="${cfg.id}" title="Delete">×</button>`}
        </div>
      </div>
      <div style="font-size:12px;color:var(--text3)">${meta}</div>
    </div>
    <div class="card-body" style="padding:12px 18px">
      <div id="pb-sc-empty-${cfg.id}" class="empty" style="display:none;padding:30px 10px"></div>
      <div id="pb-sc-wrap-${cfg.id}" style="height:260px"><canvas id="pb-sc-canvas-${cfg.id}"></canvas></div>
      <div id="pb-sc-summary-${cfg.id}" style="font-size:12px;color:var(--text3);margin-top:8px;display:flex;gap:14px;flex-wrap:wrap"></div>
    </div>`;
  stack.appendChild(wrap);
  const host = { canvasId:'pb-sc-canvas-'+cfg.id, wrapEl: wrap.querySelector('#pb-sc-wrap-'+cfg.id),
                 emptyEl: wrap.querySelector('#pb-sc-empty-'+cfg.id), summaryEl: wrap.querySelector('#pb-sc-summary-'+cfg.id) };
  _pbDrawInto(host, cfg);
}
function pbRefreshSaved(id){
  const cfg = pbLoadSaved().find(c => c.id === id);
  if (!cfg) return;
  if (cfg.mode === 'timeseries'){ // bust cache so a refresh re-fetches
    (cfg.tsSymbols||[]).forEach(s => { if (_pbHistCache[s]) delete _pbHistCache[s][cfg.range]; });
  }
  const wrap = document.getElementById('pb-sc-' + id);
  const host = { canvasId:'pb-sc-canvas-'+id, wrapEl: wrap.querySelector('#pb-sc-wrap-'+id),
                 emptyEl: wrap.querySelector('#pb-sc-empty-'+id), summaryEl: wrap.querySelector('#pb-sc-summary-'+id) };
  _pbDrawInto(host, cfg).then(()=>showToast('Chart refreshed'));
}
function pbTogglePin(id){
  const charts = pbLoadSaved();
  const cfg = charts.find(c => c.id === id);
  if (!cfg) return;
  cfg.pinned = !cfg.pinned;
  pbPersistSaved(charts);
  pbRenderAllSaved();
  showToast(cfg.pinned ? 'Chart pinned — protected from delete' : 'Chart unpinned');
}
function pbDeleteSaved(id){
  const charts = pbLoadSaved();
  const cfg = charts.find(c => c.id === id);
  if (!cfg) return;
  if (cfg.pinned){ showToast('Pinned — unpin first to delete'); return; }
  _pbConfirm('Delete "' + kjrEscape(cfg.title) + '"?', () => {
    pbPersistSaved(charts.filter(c => c.id !== id));
    const inst = _pbCharts['pb-sc-canvas-'+id]; if (inst){ try{ inst.destroy(); }catch(e){} delete _pbCharts['pb-sc-canvas-'+id]; }
    pbRenderAllSaved();
    // Soft-delete: keep the config in memory for 8s and offer an Undo on the
    // toast (matches the toast's own 8s lifetime).
    _pbUndoChart = cfg; clearTimeout(_pbUndoTimer);
    _pbUndoTimer = setTimeout(() => { _pbUndoChart = null; }, 8000);
    showToast('Chart deleted', '', { label:'Undo', fn: pbUndoDelete });
  });
}
let _pbUndoChart = null, _pbUndoTimer = null;
function pbUndoDelete(){
  if (!_pbUndoChart) { showToast('Nothing to undo'); return; }
  const charts = pbLoadSaved(); charts.push(_pbUndoChart); pbPersistSaved(charts);
  _pbUndoChart = null; pbRenderAllSaved(); showToast('Chart restored', 'success');
}
function _pbConfirm(msg, onYes){
  document.getElementById('pb-confirm-ov')?.remove();
  const ov = document.createElement('div');
  ov.id = 'pb-confirm-ov';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9900;display:flex;align-items:center;justify-content:center';
  ov.innerHTML = `<div class="card" style="padding:20px 22px;max-width:300px;width:88%">
    <div style="font-size:13px;color:var(--text);line-height:1.5;margin-bottom:16px">${msg}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-sm" id="pb-cf-no">Cancel</button>
      <button class="btn btn-sm" id="pb-cf-yes" style="background:var(--red);color:#fff;border-color:var(--red)">Delete</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#pb-cf-no').onclick = close;
  ov.querySelector('#pb-cf-yes').onclick = () => { close(); onYes(); };
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
}

function pbSetSource(val){
  if (!PB_SOURCES[val]) return;
  if (pbState.source !== val){
    pbState.source = val;
    pbState.x = []; pbState.y = [];
    if (PB_SOURCES[val].kind !== 'holdings') pbState.mode = 'crosssec';
  }
  _pbSaveState();
  renderChartBuilder();
}
function pbSetSeriesView(v){
  const valid = _pbSeriesViewOpts(pbState.source).some(([k]) => k === v);
  pbState.seriesMode = valid ? v : 'total';
  _pbSaveState();
  const classWrap = document.getElementById('pb-series-class-wrap');
  if (classWrap) classWrap.style.display = (pbState.source === 'networth' && pbState.seriesMode === 'single') ? 'flex' : 'none';
  pbRenderChart();
}
function pbSetSeriesClass(c){
  pbState.seriesClass = ['stocks','cash','cpf','realestate','crypto'].includes(c) ? c : 'cash';
  _pbSaveState();
  pbRenderChart();
}

function pbSeedDefaults(){
  // Seed the three built-in charts ONCE ever. After that the user owns them:
  // deleting a default keeps it gone across reloads (no re-seeding). Brand-new
  // installs still get all three on first render.
  // DB.settings.savedCharts === null means "never seeded" (freshDB default);
  // once seeded it is always an array, even [] after the user deletes every
  // chart, so [] must never be mistaken for "never seeded" (that would
  // resurrect deleted defaults on next boot).
  if (DB.settings.savedCharts !== null) return;
  const charts = pbLoadSaved();
  const ids = new Set(charts.map(c => c.id));
  const defaults = [
    { id:'def_networth',  title:'Net worth over time', source:'networth',  mode:'crosssec', seriesMode:'total',
      range:'ONE_YEAR',    xFields:[], yFields:[], chartType:'line', topN:'all', sort:'alpha',
      dualAxis:false, kwFilter:'', tsSymbols:[], tsValue:'price', tsAvgCost:false, pinned:true, order:0 },
    { id:'def_alloc',     title:'Allocation',          source:'allocation', mode:'crosssec', seriesMode:'total',
      range:'SIX_MONTHS', xFields:['assetClass'], yFields:['value'], chartType:'doughnut', topN:'all', sort:'desc',
      dualAxis:false, kwFilter:'', tsSymbols:[], tsValue:'price', tsAvgCost:false, pinned:true, order:1 },
    { id:'def_cashflow',  title:'Cashflow',             source:'cashflow',   mode:'crosssec', seriesMode:'total',
      range:'SIX_MONTHS', xFields:['month'], yFields:['income','expense'], chartType:'bar', topN:'all', sort:'alpha',
      dualAxis:false, kwFilter:'', tsSymbols:[], tsValue:'price', tsAvgCost:false, pinned:true, order:2 },
  ];
  defaults.forEach(def => { if (!ids.has(def.id)) charts.push(def); });
  charts.sort((a,b) => (a.order??999) - (b.order??999));
  // Always persist here, even if charts was already []: this is what flips
  // savedCharts from null ("never seeded") to a real array, so we never
  // re-enter this branch and resurrect a default the user later deletes.
  pbPersistSaved(charts);
}

/* D1: one-time migration off the four localStorage keys (pre-v2.37) into
   DB.settings, so saved charts, live builder state, seeded-defaults status
   and dash layout ride sync/export/import like the rest of the DB. Runs once
   on boot, after loadLocal() but before the first renderAll(). Guarded on the
   DB fields still being at their fresh defaults, so it never clobbers data
   that already migrated (e.g. arrived via a cloud pull on a second device).
   Removes the old keys afterwards and persists via saveData() (not
   saveLocal()) so the migrated state syncs immediately rather than waiting
   for the next unrelated edit. */
function migrateDeviceLocalChartState(){
  let migrated = false;
  try {
    const oldState = JSON.parse(localStorage.getItem(PB_STATE_KEY) || 'null');
    if (oldState && DB.settings.chartBuilder === null){
      DB.settings.chartBuilder = oldState;
      migrated = true;
    }
  } catch(e){}
  try {
    const oldSaved = JSON.parse(localStorage.getItem(PB_SAVED_KEY) || 'null');
    const wasSeeded = localStorage.getItem(PB_SEEDED_KEY) === '1';
    if (DB.settings.savedCharts === null && (Array.isArray(oldSaved) || wasSeeded)){
      // Old device had either real charts, or an empty-but-seeded state
      // (user deleted every chart), both must carry over as an array so
      // pbSeedDefaults() never re-seeds on this device.
      DB.settings.savedCharts = Array.isArray(oldSaved) ? oldSaved : [];
      migrated = true;
    }
  } catch(e){}
  try {
    const oldLayout = JSON.parse(localStorage.getItem(DASH_LAYOUT_KEY) || 'null');
    if (Array.isArray(oldLayout) && oldLayout.length && DB.settings.dashLayout.length === 0){
      DB.settings.dashLayout = oldLayout;
      migrated = true;
    }
  } catch(e){}
  localStorage.removeItem(PB_STATE_KEY);
  localStorage.removeItem(PB_SAVED_KEY);
  localStorage.removeItem(PB_SEEDED_KEY);
  localStorage.removeItem(DASH_LAYOUT_KEY);
  // Always reload the module-level builder state here, not only on migration:
  // pbState was initialised at parse time against the empty freshDB(), and
  // loadLocal() has since replaced DB with the real data. Without this, a
  // saved builder config would be ignored on every normal boot.
  pbState = _pbLoadState();
  if (migrated){
    saveData();                 // persists locally AND syncs, so the migration is not device-local
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   SECTOR ALLOCATION — stacked bar + cyclical/defensive split + flags
   ═══════════════════════════════════════════════════════════════════════ */
/* Weights use market value when every holding is priced, else fall back to
   cost basis for ALL rows — mixing the two bases would distort the split.
   'ETF / Fund' is excluded from the sector-concentration flag (a broad index
   fund is diversification, not concentration), but a single holding above
   25% still flags, ETF or not. */
function renderSectorAllocation(rows, anyPriceMissing){
  if (!rows.length) return '';
  const useMv = !anyPriceMissing;
  const basisOf = r => useMv ? (r.mv != null ? r.mv : 0) : (r.cost || 0);
  const total = roundMoney(rows.reduce((a, r) => a + basisOf(r), 0));
  if (total <= 0) return '';

  if (!rows.some(r => r.s.sector)){
    return `<div class="card alloc-card"><div class="card-body">
      <div class="alloc-head">Sector allocation</div>
      <div class="empty-sub">Tag a sector on each holding (Edit → Sector) to see the split here, plus the cyclical/defensive balance.</div>
    </div></div>`;
  }

  const bySector = {};
  rows.forEach(r => {
    const k = r.s.sector || 'Untagged';
    bySector[k] = (bySector[k] || 0) + basisOf(r);
  });
  const entries = Object.entries(bySector)
    .map(([sector, v]) => ({ sector, v, pct: safeRatio(v, total) }))
    .filter(e => e.pct != null && e.pct > 0)
    .sort((a, b) => b.v - a.v);

  // Rank-ordered token palette; Untagged is always neutral grey. Seven hues
  // cycle, so adjacent segments can never share a colour.
  const PALETTE = ['var(--accent)','var(--blue)','var(--green)','var(--amber)','var(--purple)','var(--accent2)','var(--red)'];
  let ci = 0;
  entries.forEach(e => { e.color = e.sector === 'Untagged' ? 'var(--border2)' : PALETTE[ci++ % PALETTE.length]; });

  const bar = entries.map(e =>
    `<div class="alloc-seg" style="width:${e.pct}%;background:${e.color}" title="${kjrEscape(e.sector)} ${e.pct.toFixed(1)}%"></div>`).join('');
  const legend = entries.map(e =>
    `<span class="alloc-key"><span class="alloc-dot" style="background:${e.color}"></span>${kjrEscape(e.sector)} ${e.pct.toFixed(1)}%</span>`).join('');

  // Cyclical / defensive / sensitive split (sectorClass from kjr-core.js).
  const cls = { cyclical: 0, defensive: 0, sensitive: 0 };
  let unclass = 0;
  entries.forEach(e => {
    const c = sectorClass(e.sector);
    if (c) cls[c] += e.v; else unclass += e.v;
  });
  const splitParts = [];
  if (cls.cyclical)  splitParts.push('Cyclical '    + safeRatio(cls.cyclical,  total).toFixed(0) + '%');
  if (cls.sensitive) splitParts.push('Sensitive '   + safeRatio(cls.sensitive, total).toFixed(0) + '%');
  if (cls.defensive) splitParts.push('Defensive '   + safeRatio(cls.defensive, total).toFixed(0) + '%');
  if (unclass)       splitParts.push('Unclassified ' + safeRatio(unclass,      total).toFixed(0) + '%');

  return `<div class="card alloc-card"><div class="card-body">
    <div class="alloc-head">Sector allocation <span class="hint">${useMv ? 'by market value' : 'by cost (prices missing)'}</span></div>
    <div class="alloc-stack">${bar}</div>
    <div class="alloc-legend">${legend}</div>
    ${splitParts.length ? `<div class="alloc-split" title="Cyclical sectors move with the economy, defensive demand holds in a downturn, sensitive sit in between (tech, energy, telecoms)">${splitParts.join(' · ')}</div>` : ''}
  </div></div>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   WATCHLIST — tickers you do not own yet. Same price pipeline as holdings
   (symbols join the refresh union), fixed lean columns, no money maths.
   ═══════════════════════════════════════════════════════════════════════ */
function renderWatchlist(){
  const el = document.getElementById('stocks-watchlist');
  if (!el) return;
  const list = DB.watchlist || [];

  const head = `
    <div class="card">
      <div class="card-head">
        <h3>Watchlist</h3>
        <button class="btn btn-primary btn-sm" data-click="openEntity" data-a0="watchlist">＋ Add ticker</button>
      </div>`;

  if (!list.length){
    el.innerHTML = head + `<div class="card-body"><div class="empty"><div class="empty-icon">👀</div><div class="empty-title">Nothing on watch</div><div class="empty-sub">Track tickers you are waiting to buy. Set a target price and the row flags when the market gets there. Watchlist symbols refresh together with your holdings.</div><button class="btn btn-primary" data-click="openEntity" data-a0="watchlist" style="margin-top:14px">＋ Add ticker</button></div></div></div>`;
    return;
  }

  // Map to rows so sort accessors can reference computed quote data.
  const wlRows = list.map(w => {
    const px  = priceFor('watchlist', w);
    const ccy = (px && px.currency) || (w.market === 'SGX' ? 'SGD' : 'USD');
    return { w, px, ccy };
  });

  // Sort accessors — price/target convert to SGD for consistent ordering across currencies.
  const WL_SORT_VALS = {
    symbol: r => r.w.symbol || '',
    market: r => r.w.market || '',
    sector: r => r.w.sector || '',
    price:  r => (r.px && r.px.price != null) ? toSGD(r.px.price, r.ccy) : null,
    dayPct: r => (r.px && r.px.changePct != null) ? r.px.changePct : null,
    pos52w: r => r.px ? rangePosition(r.px.price, r.px.week52Low, r.px.week52High) : null,
    peTtm:  r => (r.px && r.px.fund && r.px.fund.trailingPE  != null) ? r.px.fund.trailingPE  : null,
    pb:     r => (r.px && r.px.fund && r.px.fund.priceToBook != null) ? r.px.fund.priceToBook : null,
    target: r => r.w.targetPrice != null ? toSGD(Number(r.w.targetPrice), r.ccy) : null
  };

  const wlSort = DB.settings.watchlistSort || {};
  const wlSortFn = (wlSort.key && wlSort.dir && WL_SORT_VALS[wlSort.key]) ? WL_SORT_VALS[wlSort.key] : null;
  if (wlSortFn){
    const dir = wlSort.dir === 'desc' ? -1 : 1;
    wlRows.sort((a, b) => {
      const va = wlSortFn(a), vb = wlSortFn(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (typeof va === 'string' || typeof vb === 'string')
        ? dir * String(va).localeCompare(String(vb))
        : dir * (va - vb);
    });
  } else {
    // Default: alpha by symbol.
    wlRows.sort((a, b) => String(a.w.symbol || '').localeCompare(String(b.w.symbol || '')));
  }

  // Sortable header for watchlist — uses data-wl-sort-key to avoid routing to setStockSort.
  const wlTh = (key, lbl, extraCls) => {
    const active = wlSort.key === key && wlSort.dir;
    const glyph  = active ? `<span class="sort-glyph">${wlSort.dir === 'asc' ? '▲' : '▼'}</span>` : '';
    const aria   = active ? ` aria-sort="${wlSort.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th class="sortable${extraCls||''}" data-wl-sort-key="${key}" tabindex="0"${aria}>${lbl}${glyph}</th>`;
  };

  el.innerHTML = head + `
    <div class="tbl-wrap"><table class="holdings"><thead><tr>
      ${wlTh('symbol','Symbol',' tl')}${wlTh('market','Market',' tl')}${wlTh('sector','Sector',' tl')}
      ${wlTh('price','Price')}${wlTh('dayPct','Day %')}${wlTh('pos52w','52w pos')}
      ${wlTh('peTtm','P/E')}${wlTh('pb','P/B')}${wlTh('target','Target')}
      <th class="tl">Notes</th><th></th>
    </tr></thead><tbody>
      ${wlRows.map(({ w, px, ccy }) => {
        const f   = px && px.fund;
        const priceCell = (px && px.price != null)
          ? fmt(toSGD(px.price, ccy)) + (isStale(px.fetchedAt, 24) ? ' <span class="hint">(stale)</span>' : '')
          : '<span class="price-stale">—</span>';
        const dayCell = (px && px.changePct != null)
          ? `<span class="${px.changePct >= 0 ? 'pos' : 'neg'}">${fmtPct(px.changePct)}</span>` : '—';
        const posV = px ? rangePosition(px.price, px.week52Low, px.week52High) : null;
        const posCell = posV != null ? `<span title="0% = 52w low, 100% = 52w high">${(posV*100).toFixed(0)}%</span>` : '—';
        const peCell = (f && f.trailingPE  != null) ? f.trailingPE.toFixed(1)  : '—';
        const pbCell = (f && f.priceToBook != null) ? f.priceToBook.toFixed(2) : '—';
        // Buy target lives in the ticker's own currency, so the comparison
        // against the native quote price needs no FX at all.
        const atTarget = (w.targetPrice != null && px && px.price != null && px.price <= Number(w.targetPrice));
        const targetCell = w.targetPrice != null
          ? fmt(toSGD(Number(w.targetPrice), ccy)) + (atTarget ? ' <span class="wl-hit">✓ At target</span>' : '')
          : '—';
        const ax = encodeURIComponent(yahooSymbol(w));
        return `<tr>
          <td class="tl cell-sym">${kjrEscape(w.symbol)}</td>
          <td class="tl"><span class="tag ${w.market === 'SGX' ? 'sgx' : 'us'}">${kjrEscape(w.market || '')}</span></td>
          <td class="tl">${w.sector ? kjrEscape(w.sector) : '—'}</td>
          <td class="num">${priceCell}</td>
          <td class="num">${dayCell}</td>
          <td class="num">${posCell}</td>
          <td class="num">${peCell}</td>
          <td class="num">${pbCell}</td>
          <td class="num">${targetCell}</td>
          <td class="tl wl-note" title="${kjrEscape(w.notes || '')}">${w.notes ? kjrEscape(w.notes) : ''}</td>
          <td class="row-actions">
            <a class="btn btn-sm btn-ghost" href="../Trading/index.html?symbol=${ax}" target="_blank" rel="noopener" title="Open chart analysis for ${kjrEscape(w.symbol)}">Analyse</a>
            <button class="btn btn-sm btn-ghost btn-edit" data-edit-table="watchlist" data-edit-id="${kjrEscape(w.id)}">Edit</button>
          </td>
        </tr>`;
      }).join('')}
    </tbody></table></div></div>
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   WATCHLIST+ BOARD — a standalone Yahoo-style view over the watchlist
   tickers (DB.watchlist), with fully customisable columns. Tickers are
   still managed on the Stocks tab; this board is read + column choice only.
   Same price pipeline as holdings, so quotes are already fetched + cached.
   ═══════════════════════════════════════════════════════════════════════ */
function renderBoard(){
  const el = document.getElementById('board-list');
  if (!el) return;
  const list = DB.watchlist || [];

  if (!list.length){
    el.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><div class="empty-icon">📊</div><div class="empty-title">No tickers yet</div><div class="empty-sub">This board mirrors your Watchlist. Add tickers on the Stocks tab (under Watchlist), then shape the columns here with ⚙ Columns. Symbols refresh together with your holdings.</div></div></div></div>`;
    return;
  }

  // Same row prep as the Watchlist, so quotes/fundamentals are shared.
  const rows = list.map(w => {
    const px  = priceFor('watchlist', w);
    const ccy = (px && px.currency) || (w.market === 'SGX' ? 'SGD' : 'USD');
    return { w, px, ccy };
  });

  // Sort accessors — money values compare in SGD for consistent ordering.
  const BOARD_SORT_VALS = {
    symbol:     r => r.w.symbol || '',
    companyName:r => (r.px && r.px.shortName) || '',
    market:     r => r.w.market || '',
    sector:     r => r.w.sector || '',
    price:      r => (r.px && r.px.price != null) ? toSGD(r.px.price, r.ccy) : null,
    change:     r => (r.px && r.px.change != null) ? toSGD(r.px.change, r.ccy) : null,
    changePct:  r => (r.px && r.px.changePct != null) ? r.px.changePct : null,
    prevClose:  r => (r.px && r.px.previousClose != null) ? toSGD(r.px.previousClose, r.ccy) : null,
    dayRange:   r => (r.px && r.px.dayHigh != null) ? toSGD(r.px.dayHigh, r.ccy) : null,
    week52:     r => (r.px && r.px.week52High != null) ? toSGD(r.px.week52High, r.ccy) : null,
    pos52w:     r => r.px ? rangePosition(r.px.price, r.px.week52Low, r.px.week52High) : null,
    volume:     r => (r.px && r.px.volume != null) ? r.px.volume : null,
    mktCap:     r => (r.px && r.px.fund && r.px.fund.marketCap  != null) ? toSGD(r.px.fund.marketCap, r.px.fund.currency || r.px.currency || r.ccy) : null,
    peTtm:      r => (r.px && r.px.fund && r.px.fund.trailingPE != null) ? r.px.fund.trailingPE : null,
    peFwd:      r => (r.px && r.px.fund && r.px.fund.forwardPE  != null) ? r.px.fund.forwardPE : null,
    pb:         r => (r.px && r.px.fund && r.px.fund.priceToBook!= null) ? r.px.fund.priceToBook : null,
    beta:       r => (r.px && r.px.fund && r.px.fund.beta       != null) ? r.px.fund.beta : null,
    payout:     r => (r.px && r.px.fund && r.px.fund.payoutRatio!= null) ? r.px.fund.payoutRatio : null,
    exchange:   r => (r.px && r.px.exchange) || '',
    target:     r => r.w.targetPrice != null ? toSGD(Number(r.w.targetPrice), r.ccy) : null,
    updated:    r => (r.px && r.px.fetchedAt) || null
  };

  const sort = DB.settings.boardSort || {};
  const sortFn = (sort.key && sort.dir && BOARD_SORT_VALS[sort.key]) ? BOARD_SORT_VALS[sort.key] : null;
  if (sortFn){
    const dir = sort.dir === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const va = sortFn(a), vb = sortFn(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (typeof va === 'string' || typeof vb === 'string')
        ? dir * String(va).localeCompare(String(vb))
        : dir * (va - vb);
    });
  } else {
    rows.sort((a, b) => String(a.w.symbol || '').localeCompare(String(b.w.symbol || '')));
  }

  const cols = orderedCols('board').filter(c => c.visible);
  // Sortable header — data-board-sort-key keeps it off the holdings/watchlist routers.
  const th = (key, lbl, extraCls) => {
    const active = sort.key === key && sort.dir;
    const glyph  = active ? `<span class="sort-glyph">${sort.dir === 'asc' ? '▲' : '▼'}</span>` : '';
    const aria   = active ? ` aria-sort="${sort.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th class="sortable${extraCls || ''}" data-board-sort-key="${key}" tabindex="0"${aria}>${lbl}${glyph}</th>`;
  };
  const headCells = cols.map(c => {
    const lbl = typeof c.label === 'function' ? c.label() : c.label;
    const tl  = (c.cls && c.cls.indexOf('tl') > -1) ? ' tl' : '';
    return BOARD_SORT_VALS[c.key] ? th(c.key, lbl, tl) : `<th class="${tl ? 'tl' : ''}">${lbl}</th>`;
  }).join('');

  // fmt() converts SGD into the active display currency. Render in this tab's
  // own currency, then restore: renderBoard also runs inside renderStocks,
  // which keeps the stocks currency for the rest of its work.
  const _prevCcy = _renderCcy;
  setRenderCcy('board');
  el.innerHTML = `
    <div class="card"><div class="tbl-wrap"><table class="holdings"><thead><tr>
      ${th('symbol', 'Symbol', ' tl sticky-col')}${headCells}<th></th>
    </tr></thead><tbody>
      ${rows.map(r => {
        const cells = cols.map(c => `<td class="${c.cls}">${c.render(r)}</td>`).join('');
        const ax = encodeURIComponent(yahooSymbol(r.w));
        return `<tr>
          <td class="tl cell-sym sticky-col">${kjrEscape(r.w.symbol)}</td>
          ${cells}
          <td class="row-actions">
            <a class="btn btn-sm btn-ghost" href="../Trading/index.html?symbol=${ax}" target="_blank" rel="noopener" title="Open chart analysis for ${kjrEscape(r.w.symbol)}">Analyse</a>
            <button class="btn btn-sm btn-ghost btn-edit" data-edit-table="watchlist" data-edit-id="${kjrEscape(r.w.id)}">Edit</button>
          </td>
        </tr>`;
      }).join('')}
    </tbody></table></div></div>
  `;
  _renderCcy = _prevCcy;
}
/* Header click cycle: asc → desc → clear. Mirrors setWatchlistSort. */
function setBoardSort(key){
  const cur = DB.settings.boardSort || {};
  DB.settings.boardSort = cur.key !== key ? { key, dir:'asc' }
    : cur.dir === 'asc' ? { key, dir:'desc' }
    : { key:null, dir:null };
  saveData(); renderBoard();
}

/* ═══════════════════════════════════════════════════════════════════════
   COLUMN MANAGER (generic) — toggle visibility + reorder for any COLSETS
   surface (Holdings, Watchlist+ board). Arrow-based reorder works on desktop
   and touch alike (HTML5 drag is dead on touch, lessons.md). Changes persist
   to the surface's settings key and re-render immediately.
   ═══════════════════════════════════════════════════════════════════════ */
function renderColsPanel(setKey){
  const cs = COLSETS[setKey];
  const body = document.getElementById(cs.body);
  if (!body) return;
  const cols = orderedCols(setKey);
  const anyBackend = cols.some(c => c.backend);
  body.innerHTML = cols.map((c, i) => {
    const lbl = cs.labels[c.key] || c.key;
    const warn = c.backend ? ' <span class="hint" title="Populated on price refresh. Requires apps-script.gs v1.2 or later deployed.">⚠</span>' : '';
    return `<div class="col-mgr-row">
      <span class="col-mgr-move">
        <button class="btn btn-ghost btn-xs" title="Move up" aria-label="Move ${lbl} up" data-click="moveCol" data-a0="${setKey}" data-a1="${c.key}" data-a2="-1" ${i===0?'disabled':''}>↑</button>
        <button class="btn btn-ghost btn-xs" title="Move down" aria-label="Move ${lbl} down" data-click="moveCol" data-a0="${setKey}" data-a1="${c.key}" data-a2="1" ${i===cols.length-1?'disabled':''}>↓</button>
      </span>
      <label class="col-mgr-lbl"><input type="checkbox" ${c.visible?'checked':''} data-change="toggleCol" data-a0="${setKey}" data-a1="${c.key}"> <span>${lbl}${warn}</span></label>
    </div>`;
  }).join('') + (anyBackend
    ? `<div class="hint" style="margin-top:10px;font-size:12px">⚠ Day range, 52-week range and volume need the updated Apps Script. Redeploy the backend (see README) to fill them, otherwise they show the empty token.</div>`
    : '');
}
/* Same focus-trap pattern as openEntityModal: keydown scoped to the overlay
   (not document), Tab wraps, Escape closes, focus returns to the opener. */
let _colsOpener = null, _colsKeyTrap = null;
function openColumns(setKey){
  const cs = COLSETS[setKey];
  DB.settings[cs.key] = reconcileCols(DB.settings[cs.key], cs.reg);
  renderColsPanel(setKey);
  const ov = document.getElementById(cs.modal);
  if (!ov) return;
  _colsOpener = document.activeElement;
  if (_colsKeyTrap) ov.removeEventListener('keydown', _colsKeyTrap);
  _colsKeyTrap = function(e){
    if (e.key === 'Escape'){ e.preventDefault(); closeColumns(setKey); return; }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(ov.querySelectorAll('input:not([disabled]),button:not([disabled])'))
      .filter(el => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey){ if (document.activeElement === first){ e.preventDefault(); last.focus(); } }
    else           { if (document.activeElement === last) { e.preventDefault(); first.focus(); } }
  };
  ov.addEventListener('keydown', _colsKeyTrap);
  ov.classList.add('open');
  setTimeout(() => { const first = ov.querySelector('input,button'); if (first) first.focus(); }, 50);
}
function closeColumns(setKey){
  const ov = document.getElementById(COLSETS[setKey].modal);
  if (!ov) return;
  if (_colsKeyTrap){ ov.removeEventListener('keydown', _colsKeyTrap); _colsKeyTrap = null; }
  ov.classList.remove('open');
  if (_colsOpener && typeof _colsOpener.focus === 'function'){ try { _colsOpener.focus(); } catch (_){} }
  _colsOpener = null;
}
function _persistCols(setKey){ saveData(); COLSETS[setKey].rerender(); renderColsPanel(setKey); }
function toggleCol(setKey, colKey){
  const cs = COLSETS[setKey];
  const arr = reconcileCols(DB.settings[cs.key], cs.reg);
  const e = arr.find(x => x.key === colKey); if (e) e.visible = !e.visible;
  DB.settings[cs.key] = arr; _persistCols(setKey);
}
function moveCol(setKey, colKey, dir){
  const cs = COLSETS[setKey];
  const arr = reconcileCols(DB.settings[cs.key], cs.reg);
  const i = arr.findIndex(x => x.key === colKey); if (i < 0) return;
  const j = i + dir; if (j < 0 || j >= arr.length) return;
  const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  DB.settings[cs.key] = arr; _persistCols(setKey);
}
function resetColumns(setKey){
  const cs = COLSETS[setKey];
  DB.settings[cs.key] = defaultCols(cs.reg); _persistCols(setKey);
}
/* Holdings modal wrappers — keep the existing #stock-cols-modal markup working. */
function openStockColumns(){ openColumns('stocks'); }
function closeStockColumns(){ closeColumns('stocks'); }
function resetStockColumns(){ resetColumns('stocks'); }

/* Upcoming dividend payments — shows holdings with ex-dates in the next 90 days.
   Takes the full (unfiltered) rows array from renderStocks so share counts and
   derived values are already computed and don't need to be recalculated. */
function renderDividendTimeline(rows){
  const el = document.getElementById('stocks-dividends');
  if (!el) return;

  const today = _isoDateSG(new Date());
  const cutoff = _isoDateSG(new Date(Date.now() + 90 * 86400000));

  // Filter: ex-date set, positive divPerShare, ex-date in today..today+90d window
  const upcoming = rows
    .filter(r => r.s.divExDate && Number(r.s.divPerShare) > 0
               && r.s.divExDate >= today && r.s.divExDate <= cutoff)
    .sort((a, b) => a.s.divExDate < b.s.divExDate ? -1 : a.s.divExDate > b.s.divExDate ? 1 : 0);

  // Check whether any stock at all has an ex-date (for empty-state messaging)
  const anyExDate = rows.some(r => r.s.divExDate && Number(r.s.divPerShare) > 0);

  if (!rows.length || (!anyExDate && !upcoming.length)){
    // No holdings or no holdings with ex-dates — render prompt to set one
    if (!rows.length){
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<div class="card"><div class="card-head"><h3>Upcoming dividends <span class="badge badge-muted">next 90 days</span></h3></div>
      <div class="card-body"><div class="empty"><div class="empty-icon">📅</div>
      <div class="empty-title">No ex-dates set</div>
      <div class="empty-sub">Set an ex-date on any holding to track upcoming payments.</div>
      </div></div></div>`;
    return;
  }

  if (!upcoming.length){
    // Ex-dates exist but none in window
    el.innerHTML = `<div class="card"><div class="card-head"><h3>Upcoming dividends <span class="badge badge-muted">next 90 days</span></h3></div>
      <div class="card-body"><div class="empty"><div class="empty-icon">📅</div>
      <div class="empty-title">No payments due in the next 90 days</div>
      <div class="empty-sub">Update ex-dates after each declaration to keep this current.</div>
      </div></div></div>`;
    return;
  }

  const rows2 = upcoming.map(r => {
    const estIncome = roundMoney(toSGD(r.shares * Number(r.s.divPerShare), r.ccy));
    return `<tr>
      <td class="tl">${kjrEscape(r.s.symbol)}</td>
      <td class="tl">${fmtDateSG(r.s.divExDate)}</td>
      <td class="tl">${r.s.divPayDate ? fmtDateSG(r.s.divPayDate) : '—'}</td>
      <td class="num">${r.shares.toLocaleString('en-SG', {maximumFractionDigits:4})}</td>
      <td class="num">${toSGD(Number(r.s.divPerShare), r.ccy) != null ? fmt(toSGD(Number(r.s.divPerShare), r.ccy)) : '—'}</td>
      <td class="num">${fmt(estIncome, {dp:0})}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `<div class="card">
    <div class="card-head"><h3>Upcoming dividends <span class="badge badge-muted">next 90 days</span></h3></div>
    <div class="card-body p0"><div class="tbl-wrap"><table class="tbl">
      <thead><tr>
        <th class="tl">Symbol</th><th class="tl">Ex-date</th><th class="tl">Pay date</th>
        <th class="num">Shares</th><th class="num">Div/share (SGD)</th><th class="num">Est. income (SGD)</th>
      </tr></thead>
      <tbody>${rows2}</tbody>
    </table></div>
    <div class="card-hint">Update ex-dates after each declaration to keep this current.</div>
    </div></div>`;
}

/* Trade ledger card — sits below the positions table. Lists every buy/sell
   across all stocks; positions derive their shares + avg cost from these. */
function renderStockTxns(){
  setRenderCcy('stocks');
  const el = document.getElementById('stocks-ledger');
  if (!el) return;
  const stocks = DB.stocks || [];
  if (!stocks.length){ el.innerHTML = ''; return; } // no stocks → no ledger yet

  const symbolOf = id => { const s = stocks.find(x => x.id === id); return s ? s.symbol : '—'; };
  const ccyOf    = id => { const s = stocks.find(x => x.id === id); return s ? (s.currency || (s.market === 'SGX' ? 'SGD' : 'USD')) : 'SGD'; };
  const allTxns  = (DB.stockTxns || []).slice();
  const txns     = allTxns.slice().sort((a,b) => String(b.date||'').localeCompare(String(a.date||'')));

  const flatActive    = _ledgerView !== 'by-stock';
  const viewToggle    = `<div class="btn-group" style="display:inline-flex;gap:2px">
    <button class="btn btn-sm${flatActive?' btn-active':' btn-ghost'}" data-click="ledgerViewFlat">Flat</button>
    <button class="btn btn-sm${!flatActive?' btn-active':' btn-ghost'}" data-click="ledgerViewByStock">By stock</button>
  </div>`;

  const head = `<div class="card">
    <div class="card-head">
      <h3>Trade history</h3>
      <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
        ${viewToggle}
        <button class="btn btn-sm btn-ghost" data-click="exportLedgerCSV">Export CSV</button>
        <button class="btn btn-sm btn-ghost" data-click="clickIbkrFile">Import IBKR CSV</button>
        <input type="file" id="ibkr-file-input" accept=".csv" style="display:none" data-change="ibkrFileSelected">
        <button class="btn btn-primary btn-sm" data-click="openEntity" data-a0="stockTxns">＋ Add trade</button>
      </div>
    </div>`;

  if (!txns.length){
    el.innerHTML = head + `<div class="card-body"><div class="empty"><div class="empty-icon">🧾</div><div class="empty-title">No trades logged</div><div class="empty-sub">Log buys and sells here and the position above will track shares, average cost, and realised P&amp;L automatically. Without trades, the position uses the figures you typed in.</div></div></div></div>`;
    return;
  }

  const txnRow = (t, showSymbol) => {
    const ccy = ccyOf(t.stockId);
    const qty = Number(t.shares) || 0;
    const px  = Number(t.price) || 0;
    const fees = Number(t.fees) || 0;
    const gross = px * qty;
    const value = t.side === 'sell' ? gross - fees : gross + fees;
    const sideCls = t.side === 'sell' ? 'neg' : 'pos';
    return `<tr>
      <td class="tl">${fmtDateSG(t.date)}</td>
      <td class="tl cell-sym">${showSymbol ? kjrEscape(symbolOf(t.stockId)) : ''}</td>
      <td class="tl"><span class="tag ${sideCls}">${t.side === 'sell' ? 'SELL' : 'BUY'}</span></td>
      <td class="num">${qty}</td>
      <td class="num">${fmt(toSGD(px, ccy))}</td>
      <td class="num muted">${fees ? fmt(toSGD(fees, ccy)) : '—'}</td>
      <td class="num">${fmt(toSGD(value, ccy), {dp:0})}</td>
      <td class="tl muted">${kjrEscape(t.notes || '')}</td>
      <td class="row-actions"><button class="btn btn-sm btn-ghost btn-edit" data-edit-table="stockTxns" data-edit-id="${kjrEscape(t.id)}">Edit</button></td>
    </tr>`;
  };

  const colHead = `<thead><tr>
    <th class="tl">Date</th><th class="tl">Stock</th><th class="tl">Side</th><th>Shares</th><th>Price</th><th>Fees</th><th>Value</th><th class="tl">Notes</th><th></th>
  </tr></thead>`;

  let bodyHTML = '';
  if (flatActive){
    bodyHTML = txns.map(t => txnRow(t, true)).join('');
  } else {
    // Group by stock, ordered alpha by symbol
    const groups = {};
    allTxns.forEach(t => { (groups[t.stockId] = groups[t.stockId] || []).push(t); });
    const stockOrder = Object.keys(groups).sort((a,b) => symbolOf(a).localeCompare(symbolOf(b)));
    bodyHTML = stockOrder.map(sid => {
      const grpTxns = groups[sid].slice().sort((a,b) => String(a.date||'').localeCompare(String(b.date||'')));
      const sym = symbolOf(sid);
      const ccy = ccyOf(sid);
      const pos = deriveStockPosition(sid);
      const subtotal = pos
        ? `<tr class="subtotal-row">
            <td colspan="3" class="tl muted">Position</td>
            <td class="num">${pos.shares}</td>
            <td class="num">${fmt(toSGD(pos.avgCost, ccy))}</td>
            <td></td>
            <td class="num"><span class="${pos.realisedPL >= 0 ? 'pos' : 'neg'}">${_plArrow(pos.realisedPL)}${fmt(toSGD(pos.realisedPL, ccy), {dp:0,signed:true})}</span></td>
            <td class="tl muted">realised P&amp;L</td><td></td>
          </tr>`
        : '';
      return `<tr class="ledger-group-row"><td colspan="9" class="tl"><strong>${kjrEscape(sym)}</strong> <span class="muted">— ${grpTxns.length} trade${grpTxns.length!==1?'s':''}</span></td></tr>
        ${grpTxns.map(t => txnRow(t, false)).join('')}
        ${subtotal}`;
    }).join('');
  }

  el.innerHTML = head + `<div class="tbl-wrap"><table class="holdings">${colHead}<tbody>${bodyHTML}</tbody></table></div></div>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   CRYPTO — render
   ═══════════════════════════════════════════════════════════════════════ */
function renderCrypto(){
  setRenderCcy('crypto');
  const list = DB.crypto || [];
  const bodyEl = document.getElementById('crypto-body');
  const sumEl  = document.getElementById('crypto-summary');
  const fresh  = document.getElementById('freshness-crypto');
  if (!bodyEl) return;

  if (!list.length){
    sumEl.innerHTML = '';
    bodyEl.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><div class="empty-icon">₿</div><div class="empty-title">No coins yet</div><div class="empty-sub">Click <b>Add coin</b> and enter a common ticker like BTC, ETH, SOL. Custom coins can use the CoinGecko id override.</div><button class="btn btn-primary" data-click="openEntity" data-a0="crypto" style="margin-top:14px">＋ Add coin</button></div></div></div>`;
    if (fresh) fresh.textContent = 'No prices yet';
    return;
  }

  let totCost = 0, totMv = 0, anyPriceMissing = false, anyFxMissing = false, anyPriced = false;
  const rows = list.map(c => {
    const cid = coinIdFor(c.coingeckoId || c.symbol);
    const px  = DB._priceCache[cid] || null;
    const ccy = c.currency || 'USD';
    if (fxMissingFor(ccy)) anyFxMissing = true;
    const cost = roundMoney(toSGD((c.amount||0) * (c.avgCost||0), ccy));
    let mv = null, pl = null, plPct = null, stale = true, priceSgd = null;
    if (px && px.sgd != null){
      anyPriced = true;
      priceSgd = px.sgd; // CoinGecko prices come in SGD
      mv = roundMoney(priceSgd * (c.amount || 0));
      pl = roundMoney(mv - cost);
      plPct = safeRatio(pl, cost);
      stale = isStale(px.fetchedAt, 24);
    } else { anyPriceMissing = true; }
    totCost += cost;
    if (mv != null) totMv += mv;
    return { c, cid, px, ccy, cost, mv, pl, plPct, stale, priceSgd };
  });

  const showPl = anyPriced && !anyPriceMissing;
  const totPl = roundMoney(totMv - totCost);
  const totPlPct = safeRatio(totPl, totCost);
  const mvSub = anyFxMissing ? 'FX missing for cost basis'
              : anyPriceMissing && anyPriced ? 'some prices missing, refresh'
              : anyPriceMissing ? 'click Refresh prices to populate'
              : '';

  sumEl.innerHTML = renderSummary([
    { label:'Coins',        value: String(list.length), accent:'accent' },
    { label:'Total cost',   value: fmt(totCost, {dp:0}), sub: anyFxMissing ? 'approximate (FX missing)' : '' },
    { label:'Market value', value: anyPriced ? fmt(totMv, {dp:0}) : '—', accent:'accent', sub: mvSub },
    { label:'P&L',          value: showPl ? fmt(totPl, {dp:0}) : '—',
      sub: showPl && totPlPct != null ? fmtPct(totPlPct) : (anyPriceMissing ? 'refresh prices to compute' : ''),
      accent: showPl ? (totPl >= 0 ? 'pos' : 'neg') : '' }
  ]);

  const dc = displayCcy();
  bodyEl.innerHTML = `
    <div class="card"><div class="tbl-wrap"><table class="holdings"><thead><tr>
      <th class="tl">Symbol</th><th class="tl">CoinGecko ID</th><th>Amount</th><th>Avg cost</th>
      <th>Price (${dc})</th><th>24h</th><th>Market value (${dc})</th><th>P&L (${dc})</th><th>P&L %</th><th>Updated</th><th></th>
    </tr></thead><tbody>
      ${rows.map(r => {
        const plClass = r.pl == null ? '' : (r.pl >= 0 ? 'pos' : 'neg');
        const px = r.px;
        const chg = px && px.change24h != null ? (px.change24h >= 0 ? 'pos' : 'neg') : '';
        const priceTxt = r.priceSgd != null
          ? `${fmt(r.priceSgd)}${r.stale ? ' <span class="hint">(stale)</span>' : ''}`
          : '<span class="price-stale">—</span>';
        return `<tr>
          <td class="tl cell-sym"><span class="tag crypto">${kjrEscape(r.c.symbol)}</span></td>
          <td class="tl muted">${kjrEscape(r.cid || '—')}</td>
          <td class="num">${r.c.amount || 0}</td>
          <td class="num">${r.c.avgCost ? fmt(toSGD(r.c.avgCost, r.ccy)) : '—'}</td>
          <td class="num">${priceTxt}</td>
          <td class="num ${chg}">${px && px.change24h != null ? fmtPct(px.change24h) : '—'}</td>
          <td class="num">${r.mv != null ? fmt(r.mv, {dp:0}) : '—'}</td>
          <td class="num ${plClass}">${r.pl != null ? fmt(r.pl, {dp:0}) : '—'}</td>
          <td class="num ${plClass}">${r.plPct != null ? fmtPct(r.plPct) : '—'}</td>
          <td class="num muted">${px && px.fetchedAt ? relTime(px.fetchedAt) : '—'}</td>
          <td class="row-actions"><button class="btn btn-sm btn-ghost btn-edit" data-edit-table="crypto" data-edit-id="${kjrEscape(r.c.id)}">Edit</button></td>
        </tr>`;
      }).join('')}
    </tbody></table></div></div>
  `;

  if (fresh){
    fresh.className = 'freshness' + (anyPriceMissing ? ' stale' : ' fresh');
    fresh.textContent = priceFreshnessText('crypto');
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   REAL ESTATE — render
   ═══════════════════════════════════════════════════════════════════════ */
function renderRealestate(){
  setRenderCcy('realestate');
  const list = DB.realestate || [];
  const bodyEl = document.getElementById('realestate-body');
  const sumEl  = document.getElementById('realestate-summary');
  if (!bodyEl) return;

  if (!list.length){
    sumEl.innerHTML = '';
    bodyEl.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><div class="empty-icon">🏠</div><div class="empty-title">No properties yet</div><div class="empty-sub">Click <b>Add property</b> to record a current estimated value. Mortgage and rental cashflow come later.</div><button class="btn btn-primary" data-click="openEntity" data-a0="realestate" style="margin-top:14px">＋ Add property</button></div></div></div>`;
    return;
  }

  const total = list.reduce((s,x) => s + Number(x.value || 0), 0);
  sumEl.innerHTML = renderSummary([
    { label:'Properties',  value: String(list.length), accent:'accent' },
    { label:'Total value', value: fmt(total, {dp:0}), accent:'accent' }
  ]);

  bodyEl.innerHTML = `
    <div class="card"><div class="tbl-wrap"><table class="holdings"><thead><tr>
      <th class="tl">Name / address</th><th>Value (${displayCcy()})</th><th>Updated</th><th class="tl">Notes</th><th></th>
    </tr></thead><tbody>
      ${list.map(r => `<tr>
        <td class="tl cell-sym">${kjrEscape(r.name)}</td>
        <td class="num">${fmt(r.value, {dp:0})}</td>
        <td class="num muted">${r.updatedAt ? fmtDateSG(r.updatedAt) : '—'}</td>
        <td class="tl muted">${kjrEscape(r.notes || '')}</td>
        <td class="row-actions"><button class="btn btn-sm btn-ghost btn-edit" data-edit-table="realestate" data-edit-id="${kjrEscape(r.id)}">Edit</button></td>
      </tr>`).join('')}
    </tbody></table></div></div>
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   CASH — derived balances for brokerage accounts
   ═══════════════════════════════════════════════════════════════════════ */
function isBrokerageAcct(acct){ return acct && acct.account === 'Brokerage'; }

/* Signed effect of a cash movement on the balance, in the account currency. */
function cashMovementDelta(t){
  const amt = Number(t.amount) || 0;
  if (t.type === 'adjustment') return amt;                 // signed as entered
  if (t.type === 'withdrawal' || t.type === 'fee') return -Math.abs(amt);
  return Math.abs(amt);                                    // deposit/dividend/interest
}

/* Net cash effect of a linked stock trade on its funding account, in the
   trade currency. Buys debit (incl. fees), sells credit (net of fees). */
function cashTradeFlow(t){
  const qty = Math.abs(Number(t.shares) || 0);
  const px  = Number(t.price) || 0;
  const fees = Number(t.fees) || 0;
  return t.side === 'sell' ? (px * qty - fees) : -(px * qty + fees);
}

/* Amount credited to a transfer's destination account, in the destination
   currency. Uses amountIn when given (cross-currency), else the out amount. */
function transferInAmount(t){
  const ai = (t.amountIn != null && t.amountIn !== '') ? Number(t.amountIn) : NaN;
  return isFinite(ai) ? Math.abs(ai) : Math.abs(Number(t.amount) || 0);
}

/* Live balance of any cash account, in its own currency:
   typed balance (as-of opening) + later movements + transfers in/out + linked
   trade flows. A pure manual account with no activity just shows its typed
   amount. The typed balance is anchored to acct.asOf: anything dated on/before
   that is assumed already inside it, so only later movements accrue (mirrors
   the CPF anchor model). No asOf → every movement accrues (legacy behaviour). */
function deriveCashBalance(acct){
  let bal = Number(acct.amount) || 0;
  const asOf = acct.asOf || '';
  const accrues = d => !asOf || String(d || '') > asOf;
  (DB.cashTxns || []).forEach(t => {
    if (!accrues(t.date)) return;                          // already in the opening
    if (t.type === 'transfer'){
      if (t.fromAccountId === acct.id) bal -= Math.abs(Number(t.amount) || 0);
      if (t.cashAccountId === acct.id) bal += transferInAmount(t);
    } else if (t.cashAccountId === acct.id){
      bal += cashMovementDelta(t);
    }
  });
  (DB.stockTxns || []).forEach(t => { if (t.cashAccountId === acct.id && accrues(t.date)) bal += cashTradeFlow(t); });
  return bal;
}

/* Whether an account has any linked movements or trades (drives the ◆ mark). */
function hasCashActivity(acct){
  return (DB.cashTxns || []).some(t => t.cashAccountId === acct.id || t.fromAccountId === acct.id)
      || (DB.stockTxns || []).some(t => t.cashAccountId === acct.id);
}

/* Projected monthly interest for one account using its APY field.
   Uses the derived balance so movements/trades are included automatically. */
function projectedMonthlyInterest(acct){
  const apy = Number(acct.apy) || 0;
  if (!apy) return 0;
  return deriveCashBalance(acct) * (apy / 100) / 12;
}
function projectedAnnualInterest(acct){
  return projectedMonthlyInterest(acct) * 12;
}

/* ═══════════════════════════════════════════════════════════════════════
   CASH — render
   ═══════════════════════════════════════════════════════════════════════ */
function renderCash(){
  setRenderCcy('cash');
  const list = DB.cash || [];
  const bodyEl = document.getElementById('cash-body');
  const sumEl  = document.getElementById('cash-summary');
  const fresh  = document.getElementById('freshness-fx');
  if (!bodyEl) return;

  if (fresh){
    const foreignCcys = Array.from(new Set(list.map(c => (c.currency || 'SGD').toUpperCase()).filter(c => c !== 'SGD')));
    const hasForeign = foreignCcys.length > 0;
    const allHaveRates = foreignCcys.every(c => getFx(c, 'SGD') != null);
    fresh.className = 'freshness' + (hasForeign && !allHaveRates ? ' stale' : (allHaveRates || !hasForeign ? ' fresh' : ''));
    fresh.textContent = fxFreshnessText();
  }

  if (!list.length){
    sumEl.innerHTML = '';
    bodyEl.innerHTML = `<div class="card"><div class="card-body"><div class="empty"><div class="empty-icon">💵</div><div class="empty-title">No cash accounts yet</div><div class="empty-sub">Click <b>Add account</b> to log a bank balance, fixed deposit, or foreign currency holding. Foreign balances convert to SGD using FX from Settings.</div><button class="btn btn-primary" data-click="openEntity" data-a0="cash" style="margin-top:14px">＋ Add account</button></div></div></div>`;
    return;
  }

  let totSgd = 0, fxMissing = false, totInterestSgd = 0, excludedCount = 0;
  const rows = list.map(c => {
    const ccy = c.currency || 'SGD';
    const bal = deriveCashBalance(c);          // native-currency balance
    const sgd = sgdOrNull(bal, ccy);           // null when the currency can't be converted
    if (fxMissingFor(ccy)) fxMissing = true;
    if (sgd == null) excludedCount++;
    else totSgd += sgd;
    const monthlyInt  = projectedMonthlyInterest(c);
    const annualInt   = monthlyInt * 12;
    const intSgd      = toSGD(annualInt, ccy);
    if (sgd != null) totInterestSgd += intSgd;
    return { c, ccy, sgd, bal, derived: hasCashActivity(c), apy: Number(c.apy)||0, monthlyInt };
  });

  const showApy = rows.some(r => r.apy > 0);

  // Currency breakdown
  const byCcy = {};
  rows.forEach(r => { byCcy[r.ccy] = (byCcy[r.ccy] || 0) + r.bal; });
  const ccyChips = Object.entries(byCcy).map(([k,v]) => `<span class="tag money-chip" style="margin-right:6px">${kjrEscape(k)} ${v.toLocaleString('en-SG', {maximumFractionDigits:2})}</span>`).join('');

  const summaryCards = [
    { label:'Accounts',    value: String(list.length), accent:'accent' },
    { label:'Total (' + displayCcy() + ')', value: fmt(totSgd, {dp:0}), accent:'accent',
      sub: excludedCount ? excludedCount + ' account' + (excludedCount>1?'s':'') + ' excluded from total, FX missing'
         : fxMissing ? 'FX missing for some, set in Settings or refresh' : '' },
    { label:'By currency', value: '', sub: ccyChips || '—' }
  ];
  if (showApy){
    summaryCards.push({ label:'Projected annual interest', value: fmt(totInterestSgd, {dp:0}), accent:'accent', sub:'Based on APY × current balances' });
  }
  sumEl.innerHTML = renderSummary(summaryCards);

  bodyEl.innerHTML = `
    <div class="card"><div class="tbl-wrap"><table class="holdings"><thead><tr>
      <th class="tl">Account</th><th class="tl">Type</th><th>Balance</th><th>Currency</th><th>${displayCcy()} value</th>
      ${showApy ? '<th>APY %</th><th>Monthly interest</th>' : ''}
      <th class="tl">Notes</th><th></th>
    </tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td class="tl cell-sym">${kjrEscape(r.c.name)}</td>
        <td class="tl"><span class="tag">${kjrEscape(r.c.account || '—')}</span></td>
        <td class="num ${r.bal < -0.005 ? 'neg' : ''}">${r.bal.toLocaleString('en-SG', {maximumFractionDigits:2})}${r.derived ? '<span class="hint" title="Calculated from movements + linked trades"> ◆</span>' : ''}</td>
        <td class="num">${kjrEscape(r.ccy)}</td>
        <td class="num ${r.bal < -0.005 ? 'neg' : ''}">${r.sgd != null ? fmt(r.sgd) : '<span class="price-stale">— FX missing</span>'}</td>
        ${showApy ? `<td class="num">${r.apy ? r.apy.toFixed(2) + '%' : '—'}</td><td class="num">${r.monthlyInt ? r.c.currency && r.c.currency !== 'SGD' ? r.c.currency + ' ' + r.monthlyInt.toLocaleString('en-SG',{maximumFractionDigits:2}) : fmt(toSGD(r.monthlyInt, r.ccy)) : '—'}</td>` : ''}
        <td class="tl muted">${kjrEscape(r.c.notes || '')}</td>
        <td class="row-actions"><button class="btn btn-sm btn-ghost btn-edit" data-edit-table="cash" data-edit-id="${kjrEscape(r.c.id)}">Edit</button></td>
      </tr>`).join('')}
    </tbody></table></div></div>
  `;

  renderCashTxns();
}

/* Cash movements ledger — deposits, withdrawals, dividends, interest, fees.
   Sits below the cash table. Brokerage balances derive from these plus any
   linked stock trades. */
function renderCashTxns(){
  setRenderCcy('cash');
  const el = document.getElementById('cash-ledger');
  if (!el) return;
  const accts = DB.cash || [];
  if (!accts.length){ el.innerHTML = ''; return; }

  const nameOf = id => { const a = accts.find(x => x.id === id); return a ? a.name : '—'; };
  const ccyOf  = id => { const a = accts.find(x => x.id === id); return a ? (a.currency || 'SGD') : 'SGD'; };
  // Same-day entries (e.g. the auto salary → transfer → assumed-spend trio)
  // must stay in creation order, not whatever order storage happens to return.
  // uid()'s Date.now()-based prefix makes id a reliable creation-order key.
  const txns = (DB.cashTxns || []).slice().sort((a,b) => {
    const byDate = String(b.date||'').localeCompare(String(a.date||''));
    return byDate !== 0 ? byDate : String(a.id||'').localeCompare(String(b.id||''));
  });

  const head = `<div class="card">
      <div class="card-head"><h3>Cash Movements</h3>
        <button class="btn btn-primary btn-sm" data-click="openEntity" data-a0="cashTxns">＋ Add movement</button>
      </div>`;

  const TYPE_LABEL = { deposit:'Deposit', withdrawal:'Withdrawal', transfer:'Transfer', dividend:'Dividend', interest:'Interest', fee:'Fee', adjustment:'Adjustment' };

  if (!txns.length){
    el.innerHTML = head + `<div class="card-body"><div class="empty"><div class="empty-icon">🧾</div><div class="empty-title">No cash movements</div><div class="empty-sub">Log deposits, withdrawals, transfers, dividends, and interest here. Account balances are calculated from these plus any trades funded from them.</div></div></div></div>`;
    return;
  }

  el.innerHTML = head + `
    <div class="tbl-wrap"><table class="holdings"><thead><tr>
      <th class="tl">Date</th><th class="tl">Account</th><th class="tl">Type</th><th>Amount</th><th class="tl">Notes</th><th></th>
    </tr></thead><tbody>
      ${txns.map(t => {
        if (t.type === 'transfer'){
          const outCcy = ccyOf(t.fromAccountId), inCcy = ccyOf(t.cashAccountId);
          const outAmt = Math.abs(Number(t.amount) || 0), inAmt = transferInAmount(t);
          const sameCcy = outCcy === inCcy && outAmt === inAmt;
          // Transfers show native amounts (not the display currency) so the
          // FX leg is visible, e.g. S$27,000 → US$20,000.
          const amtTxt = sameCcy
            ? fmt(outAmt, { currency: outCcy })
            : `${fmt(outAmt, { currency: outCcy })} → ${fmt(inAmt, { currency: inCcy })}`;
          return `<tr>
            <td class="tl">${fmtDateSG(t.date)}</td>
            <td class="tl cell-sym">${kjrEscape(nameOf(t.fromAccountId))} → ${kjrEscape(nameOf(t.cashAccountId))}</td>
            <td class="tl"><span class="tag">Transfer</span></td>
            <td class="num">${amtTxt}</td>
            <td class="tl muted">${kjrEscape(t.notes || '')}</td>
            <td class="row-actions"><button class="btn btn-sm btn-ghost btn-edit" data-edit-table="cashTxns" data-edit-id="${kjrEscape(t.id)}">Edit</button></td>
          </tr>`;
        }
        const ccy = ccyOf(t.cashAccountId);
        const delta = cashMovementDelta(t);
        const cls = delta >= 0 ? 'pos' : 'neg';
        return `<tr>
          <td class="tl">${fmtDateSG(t.date)}</td>
          <td class="tl cell-sym">${kjrEscape(nameOf(t.cashAccountId))}</td>
          <td class="tl"><span class="tag ${delta >= 0 ? 'pos' : 'neg'}">${kjrEscape(TYPE_LABEL[t.type] || t.type)}</span></td>
          <td class="num ${cls}">${fmt(toSGD(delta, ccy))}</td>
          <td class="tl muted">${kjrEscape(t.notes || '')}</td>
          <td class="row-actions"><button class="btn btn-sm btn-ghost btn-edit" data-edit-table="cashTxns" data-edit-id="${kjrEscape(t.id)}">Edit</button></td>
        </tr>`;
      }).join('')}
    </tbody></table></div></div>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   CPF — balances editor + transaction history
   ═══════════════════════════════════════════════════════════════════════ */
const CPF_ACCOUNTS = ['OA','SA','MA','RA'];

/* The date the typed balances were captured. Everything dated on/before it is
   assumed already inside those figures; only later movements accrue on top. */
function _cpfAnchorDate(){
  const b = DB.cpfBalances || {};
  return b.anchorDate || (b.updatedAt ? String(b.updatedAt).slice(0,10) : '');
}

/* Live CPF = the typed opening figure per account, plus every history entry
   (auto contribution or manual) dated after the anchor. This is what the CPF
   tab and net worth show, so the balance grows each payday on its own. */
function cpfEffectiveBalances(){
  const b = DB.cpfBalances || {};
  const out = { OA:Number(b.OA)||0, SA:Number(b.SA)||0, MA:Number(b.MA)||0, RA:Number(b.RA)||0 };
  const anchor = _cpfAnchorDate();
  (DB.cpfHistory || []).forEach(h => {
    if (out[h.account] == null) return;
    if (anchor && String(h.date || '') <= anchor) return;   // already in the opening figure
    out[h.account] += Number(h.amount) || 0;
  });
  return out;
}

/* Per-account CPF balance as of an arbitrary month-end. Same rule as
   cpfEffectiveBalances (opening + post-anchor entries) but capped at a cutoff
   date, so the Chart Builder can reconstruct the monthly trend. */
function cpfBalancesAsOf(cutoffISO){
  const b = DB.cpfBalances || {};
  const out = { OA:Number(b.OA)||0, SA:Number(b.SA)||0, MA:Number(b.MA)||0, RA:Number(b.RA)||0 };
  const anchor = _cpfAnchorDate();
  (DB.cpfHistory || []).forEach(h => {
    if (out[h.account] == null) return;
    const d = String(h.date || '');
    if (anchor && d <= anchor) return;        // already inside the opening figure
    if (cutoffISO && d > cutoffISO) return;    // not yet credited as of the cutoff
    out[h.account] += Number(h.amount) || 0;
  });
  return out;
}

/* Month-end ISO dates from the CPF anchor's month through the current month.
   The latest entry is clamped to today so the current (partial) month shows. */
function _cpfMonthEnds(){
  const anchor = _cpfAnchorDate();
  if (!anchor) return [];
  const start = new Date(anchor.slice(0,7) + '-01T00:00:00');
  const today = _isoDate(new Date());
  const out = [];
  let y = start.getFullYear(), m = start.getMonth() + 1;   // 1-based month
  const now = new Date();
  const endY = now.getFullYear(), endM = now.getMonth() + 1;
  while (y < endY || (y === endY && m <= endM)){
    let me = _lastDayOfMonthISO(y, m);
    if (me > today) me = today;                 // clamp the current partial month
    out.push(me);
    m++; if (m > 12){ m = 1; y++; }
  }
  return out;
}

function saveCpfBalancesFromForm(){
  const numOrNull = (id) => {
    const v = document.getElementById(id).value;
    if (v === '' || v == null) return null;
    const n = Number(v); return isNaN(n) ? null : n;
  };
  DB.cpfBalances.OA = numOrNull('cpf-bal-OA') ?? 0;
  DB.cpfBalances.SA = numOrNull('cpf-bal-SA') ?? 0;
  DB.cpfBalances.MA = numOrNull('cpf-bal-MA') ?? 0;
  DB.cpfBalances.RA = numOrNull('cpf-bal-RA') ?? 0;
  // Re-anchor to today: the figure just typed becomes the new opening balance,
  // and accrual restarts from here. runSalaryEngine then prunes now-stale auto
  // rows and grows forward from the next payday.
  DB.cpfBalances.updatedAt  = new Date().toISOString();
  DB.cpfBalances.anchorDate = _isoDate(new Date());
  runSalaryEngine();
  saveData();
  renderAll();
  loadSettingsForm();
  showToast('Starting balances saved. CPF now grows on its own from salary + interest.', 'success');
}

function loadCpfBalancesForm(){
  const b = DB.cpfBalances || {};
  CPF_ACCOUNTS.forEach(a => {
    const el = document.getElementById('cpf-bal-' + a);
    if (el) el.value = b[a] != null ? b[a] : '';
  });
}

function renderCpf(){
  setRenderCcy('cpf');
  const balsEl = document.getElementById('cpf-balances');
  const histEl = document.getElementById('cpf-history-body');
  const metaEl = document.getElementById('cpf-balances-meta');
  if (!balsEl || !histEl) return;

  const bals = DB.cpfBalances || { OA:0, SA:0, MA:0, RA:0 };
  const opening = (bals.OA||0) + (bals.SA||0) + (bals.MA||0) + (bals.RA||0);
  const eff = cpfEffectiveBalances();                       // opening + post-anchor accrual
  const total = eff.OA + eff.SA + eff.MA + eff.RA;
  const accrued = total - opening;
  const anchor = _cpfAnchorDate();
  const subLine = accrued > 0.5
    ? '+' + fmt(accrued, {dp:0}) + ' since ' + (anchor ? fmtDateSG(anchor) : '—') + ' (salary + year-end interest)'
    : (anchor ? 'Anchored ' + fmtDateSG(anchor) : 'Set starting balances in Settings');

  // KPI row — live balance (typed figure auto-grown by salary each payday)
  balsEl.innerHTML = `<div class="metrics">
    <div class="metric"><div class="metric-label">Total CPF</div><div class="metric-value">${fmt(total)}</div><div class="metric-sub${accrued > 0.5 ? ' pos' : ''}">${kjrEscape(subLine)}</div></div>
    <div class="metric"><div class="metric-label">OA · ${DB.settings.cpfRates.OA}%</div><div class="metric-value">${fmt(eff.OA||0)}</div></div>
    <div class="metric"><div class="metric-label">SA · ${DB.settings.cpfRates.SA}%</div><div class="metric-value">${fmt(eff.SA||0)}</div></div>
    <div class="metric"><div class="metric-label">MA · ${DB.settings.cpfRates.MA}%</div><div class="metric-value">${fmt(eff.MA||0)}</div></div>
    <div class="metric"><div class="metric-label">RA · ${DB.settings.cpfRates.RA}%</div><div class="metric-value">${fmt(eff.RA||0)}</div></div>
  </div>`;

  if (metaEl) metaEl.textContent = anchor ? 'Statement figure as of ' + fmtDateSG(anchor) : 'Not set yet';

  loadCpfBalancesForm();

  // History
  const all = (DB.cpfHistory || []).slice();
  // Year dropdown — derive from data, default to current year if available
  const years = Array.from(new Set(all.map(h => String(h.date || '').slice(0,4)).filter(Boolean))).sort().reverse();
  const yrSel = document.getElementById('cpf-filter-year');
  if (yrSel){
    const prev = yrSel.value;
    yrSel.innerHTML = '<option value="">All years</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
    if (prev && years.includes(prev)) yrSel.value = prev;
  }
  const fYear = (yrSel && yrSel.value) || '';
  const fType = document.getElementById('cpf-filter-type')?.value || '';
  const fAcc  = document.getElementById('cpf-filter-account')?.value || '';
  const filtered = all.filter(h => {
    if (fYear && String(h.date || '').slice(0,4) !== fYear) return false;
    if (fType && h.type !== fType) return false;
    if (fAcc  && h.account !== fAcc) return false;
    return true;
  }).sort((a,b) => String(b.date || '').localeCompare(String(a.date || '')));

  if (!all.length){
    histEl.innerHTML = `<div class="empty"><div class="empty-icon">📜</div><div class="empty-title">No history yet</div><div class="empty-sub">Click <b>Add entry</b> to log contributions and interest credits from your CPF statement. Use negative amounts for withdrawals.</div></div>`;
    return;
  }
  if (!filtered.length){
    histEl.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><div class="empty-title">No entries match the filters</div><div class="empty-sub">Adjust the year, type, or account filters above.</div></div>`;
    return;
  }

  // Subtotals on filtered set
  const subBy = { OA:0, SA:0, MA:0, RA:0 };
  filtered.forEach(h => { if (subBy[h.account] != null) subBy[h.account] += Number(h.amount) || 0; });
  const subTotal = subBy.OA + subBy.SA + subBy.MA + subBy.RA;

  histEl.innerHTML = `
    <div class="h-summary" style="margin-bottom:14px">
      <div class="h-summary-item accent"><div class="h-summary-label">Entries</div><div class="h-summary-value">${filtered.length}</div></div>
      <div class="h-summary-item ${subTotal >= 0 ? 'pos':'neg'}"><div class="h-summary-label">Filtered net</div><div class="h-summary-value">${fmt(subTotal,{dp:0})}</div></div>
      <div class="h-summary-item"><div class="h-summary-label">OA</div><div class="h-summary-value">${fmt(subBy.OA,{dp:0})}</div></div>
      <div class="h-summary-item"><div class="h-summary-label">SA</div><div class="h-summary-value">${fmt(subBy.SA,{dp:0})}</div></div>
      <div class="h-summary-item"><div class="h-summary-label">MA</div><div class="h-summary-value">${fmt(subBy.MA,{dp:0})}</div></div>
      <div class="h-summary-item"><div class="h-summary-label">RA</div><div class="h-summary-value">${fmt(subBy.RA,{dp:0})}</div></div>
    </div>
    <div class="tbl-wrap"><table class="holdings"><thead><tr>
      <th class="tl">Date</th><th class="tl">Type</th><th class="tl">Account</th><th>Amount</th><th class="tl">Source</th><th class="tl">Notes</th><th></th>
    </tr></thead><tbody>
      ${filtered.map(h => {
        const cls = (Number(h.amount) || 0) >= 0 ? 'pos' : 'neg';
        return `<tr>
          <td class="tl">${fmtDateSG(h.date)}</td>
          <td class="tl"><span class="tag ${cpfTypeColour(h.type)}">${kjrEscape(h.type)}</span></td>
          <td class="tl"><span class="tag">${kjrEscape(h.account)}</span></td>
          <td class="num ${cls}">${fmt(Number(h.amount) || 0)}</td>
          <td class="tl muted">${kjrEscape(h.source || '')}</td>
          <td class="tl muted">${kjrEscape(h.notes || '')}</td>
          <td class="row-actions"><button class="btn btn-sm btn-ghost btn-edit" data-edit-table="cpfHistory" data-edit-id="${kjrEscape(h.id)}">Edit</button></td>
        </tr>`;
      }).join('')}
    </tbody></table></div>
  `;
}

function cpfTypeColour(t){
  if (t === 'contribution') return 'us';      // accent (teal)
  if (t === 'interest')     return 'crypto';  // amber
  if (t === 'transfer')     return 'sgx';     // blue
  if (t === 'withdrawal')   return '';        // neutral
  return '';
}

/* ═══════════════════════════════════════════════════════════════════════
   CASHFLOW — income + expenses + monthly roll-up
   ═══════════════════════════════════════════════════════════════════════ */

function _ymOf(date){ return String(date || '').slice(0, 7); }   // YYYY-MM
function _ymLabel(ym){
  // "2026-03" → "Mar 2026" (en-SG)
  if (!/^\d{4}-\d{2}$/.test(ym)) return ym;
  const [y,m] = ym.split('-');
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return monthNames[Number(m)-1] + ' ' + y;
}

function expenseAmountSgd(x){
  return toSGD(Number(x.amount) || 0, x.currency || 'SGD');
}
/* Strict variant for totals (KPI, monthly roll-up): null when the currency
   can't be converted, so an unconvertible expense is excluded rather than
   counted 1:1 into an SGD total. */
function expenseAmountSgdOrNull(x){
  return sgdOrNull(Number(x.amount) || 0, x.currency || 'SGD');
}

function renderCashflow(){
  setRenderCcy('cashflow');
  const rollupEl  = document.getElementById('cf-rollup-body');
  const incomeEl  = document.getElementById('cf-income-body');
  const expenseEl = document.getElementById('cf-expense-body');
  if (!rollupEl || !incomeEl || !expenseEl) return;

  const allIncome   = DB.income   || [];
  const allExpenses = DB.expenses || [];

  // Year filter — derived from union of incomes + expenses, defaults to all
  const yrSel = document.getElementById('cf-filter-year');
  const years = Array.from(new Set([...allIncome, ...allExpenses].map(r => String(r.date || '').slice(0,4)).filter(Boolean))).sort().reverse();
  if (yrSel){
    const prev = yrSel.value;
    yrSel.innerHTML = '<option value="">All years</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
    if (prev && years.includes(prev)) yrSel.value = prev;
  }
  const fYear = yrSel?.value || '';

  // Category filter — derived from DB.categories.expense + values actually used
  const catSel = document.getElementById('cf-filter-category');
  if (catSel){
    const prev = catSel.value;
    const usedCats = Array.from(new Set([
      ...(DB.categories?.expense || []),
      ...allExpenses.map(x => x.category).filter(Boolean)
    ]));
    catSel.innerHTML = '<option value="">All categories</option>' + usedCats.map(c => `<option value="${kjrEscape(c)}">${kjrEscape(c)}</option>`).join('');
    if (prev && usedCats.includes(prev)) catSel.value = prev;
  }
  const fCat = catSel?.value || '';

  const income   = allIncome.filter(r => !fYear || String(r.date || '').startsWith(fYear));
  const expenses = allExpenses.filter(r => (!fYear || String(r.date || '').startsWith(fYear)) && (!fCat || r.category === fCat));

  // ─── KPI summary (top of page) ──────────────────────────────────────
  const totGross = income.reduce((s,i) => s + (Number(i.gross) || 0), 0);
  const totNet   = income.reduce((s,i) => s + incomeNet(i), 0);
  // Exclude expenses whose currency can't be converted to SGD rather than
  // counting them 1:1, which would silently inflate the total.
  let totExp = 0, excludedExpCount = 0;
  expenses.forEach(x => {
    const sgd = expenseAmountSgdOrNull(x);
    if (sgd == null) excludedExpCount++;
    else totExp += sgd;
  });
  const savings  = totNet - totExp;
  const savingsRate = totNet > 0 ? (savings / totNet * 100) : null;
  const sumEl = document.getElementById('cf-summary');
  if (sumEl){
    sumEl.innerHTML = renderSummary([
      { label: fYear ? 'Income ' + fYear : 'Income (all years)',  value: fmt(totNet,{dp:0}),  accent:'pos', sub: 'gross ' + fmt(totGross,{dp:0}) },
      { label: fYear ? 'Expenses ' + fYear : 'Expenses (all years)', value: fmt(totExp,{dp:0}), accent:'neg',
        sub: expenses.length + ' txns' + (excludedExpCount ? ' · ' + excludedExpCount + ' excluded, FX missing' : '') },
      { label: 'Net savings', value: fmt(savings,{dp:0}), accent: savings >= 0 ? 'pos' : 'neg' },
      { label: 'Savings rate', value: savingsRate != null ? fmtPct(savingsRate) : '—', accent: savingsRate != null && savingsRate >= 0 ? 'pos' : 'neg', sub: 'of take-home' }
    ]);
  }

  // ─── Monthly roll-up table ──────────────────────────────────────────
  const ymSet = new Set();
  income.forEach(i => { const ym = _ymOf(i.date); if (ym) ymSet.add(ym); });
  expenses.forEach(x => { const ym = _ymOf(x.date); if (ym) ymSet.add(ym); });
  const months = Array.from(ymSet).sort().reverse();

  if (!months.length){
    rollupEl.innerHTML = `<div class="empty"><div class="empty-icon">📅</div><div class="empty-title">No P&L data yet</div><div class="empty-sub">Add an income entry and a few expenses to see your monthly net and savings rate.</div></div>`;
  } else {
    rollupEl.innerHTML = `<div class="tbl-wrap"><table class="holdings"><thead><tr>
      <th class="tl">Month</th><th>Income (net)</th><th>Income (gross)</th><th>Expenses</th><th>Net</th><th>Savings rate</th><th>Txns</th>
    </tr></thead><tbody>${months.map(ym => {
      const mIn = income.filter(i => _ymOf(i.date) === ym);
      const mEx = expenses.filter(x => _ymOf(x.date) === ym);
      const gross = mIn.reduce((s,i) => s + (Number(i.gross) || 0), 0);
      const net   = mIn.reduce((s,i) => s + incomeNet(i), 0);
      const exp   = mEx.reduce((s,x) => { const sgd = expenseAmountSgdOrNull(x); return s + (sgd == null ? 0 : sgd); }, 0);
      const ne    = net - exp;
      const rate  = net > 0 ? (ne / net * 100) : null;
      const cls   = ne >= 0 ? 'pos' : 'neg';
      return `<tr>
        <td class="tl cell-sym">${_ymLabel(ym)}</td>
        <td class="num">${fmt(net,{dp:0})}</td>
        <td class="num muted">${fmt(gross,{dp:0})}</td>
        <td class="num">${fmt(exp,{dp:0})}</td>
        <td class="num ${cls}">${fmt(ne,{dp:0})}</td>
        <td class="num ${cls}">${rate != null ? fmtPct(rate) : '—'}</td>
        <td class="num muted">${mIn.length + mEx.length}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  }

  const rollupMeta = document.getElementById('cf-rollup-meta');
  if (rollupMeta) rollupMeta.textContent = months.length + ' month' + (months.length === 1 ? '' : 's');

  // ─── Income table ───────────────────────────────────────────────────
  const incomeMeta = document.getElementById('cf-income-meta');
  if (incomeMeta) incomeMeta.textContent = income.length + ' entr' + (income.length === 1 ? 'y' : 'ies') + ' · ' + fmt(totNet,{dp:0}) + ' take-home';
  if (!income.length){
    incomeEl.innerHTML = `<div class="empty"><div class="empty-icon">💰</div><div class="empty-title">No income yet</div><div class="empty-sub">Click <b>＋ Add income</b> to log a salary, bonus, or other inflow.</div><button class="btn btn-primary" data-click="openEntity" data-a0="income" style="margin-top:14px">＋ Add income</button></div>`;
  } else {
    const sortedIn = income.slice().sort((a,b) => String(b.date || '').localeCompare(String(a.date || '')));
    incomeEl.innerHTML = `<div class="tbl-wrap"><table class="holdings"><thead><tr>
      <th class="tl">Date</th><th>Gross</th><th>Take-home</th><th>Employer CPF</th><th>Employee CPF</th><th class="tl">Source</th><th class="tl">Notes</th><th></th>
    </tr></thead><tbody>${sortedIn.map(i => `<tr>
      <td class="tl">${fmtDateSG(i.date)}</td>
      <td class="num">${fmt(Number(i.gross) || 0,{dp:0})}</td>
      <td class="num pos">${fmt(incomeNet(i),{dp:0})}</td>
      <td class="num muted">${i.employerCPF ? fmt(Number(i.employerCPF),{dp:0}) : '—'}</td>
      <td class="num muted">${i.employeeCPF ? fmt(Number(i.employeeCPF),{dp:0}) : '—'}</td>
      <td class="tl">${kjrEscape(i.source || '')}</td>
      <td class="tl muted">${kjrEscape(i.notes || '')}</td>
      <td class="row-actions"><button class="btn btn-sm btn-ghost btn-edit" data-edit-table="income" data-edit-id="${kjrEscape(i.id)}">Edit</button></td>
    </tr>`).join('')}</tbody></table></div>`;
  }

  // ─── Expense table ──────────────────────────────────────────────────
  const expenseMeta = document.getElementById('cf-expense-meta');
  if (expenseMeta) expenseMeta.textContent = expenses.length + ' txn' + (expenses.length === 1 ? '' : 's') + ' · ' + fmt(totExp);
  if (!expenses.length){
    expenseEl.innerHTML = `<div class="empty"><div class="empty-icon">🧾</div><div class="empty-title">No expenses yet</div><div class="empty-sub">Click <b>＋ Add expense</b> to log a transaction.</div><button class="btn btn-primary" data-click="openEntity" data-a0="expenses" style="margin-top:14px">＋ Add expense</button></div>`;
  } else {
    const sortedEx = expenses.slice().sort((a,b) => String(b.date || '').localeCompare(String(a.date || '')));
    expenseEl.innerHTML = `<div class="tbl-wrap"><table class="holdings"><thead><tr>
      <th class="tl">Date</th><th>Amount</th><th>Currency</th><th>${displayCcy()}</th><th class="tl">Category</th><th class="tl">Sub-category</th><th class="tl">Merchant</th><th class="tl">Notes</th><th></th>
    </tr></thead><tbody>${sortedEx.map(x => `<tr>
      <td class="tl">${fmtDateSG(x.date)}</td>
      <td class="num">${Number(x.amount || 0).toLocaleString('en-SG', {maximumFractionDigits:2})}</td>
      <td class="num">${kjrEscape(x.currency || 'SGD')}</td>
      <td class="num neg">${expenseAmountSgdOrNull(x) != null ? fmt(expenseAmountSgd(x)) : '<span class="price-stale">— FX missing</span>'}</td>
      <td class="tl"><span class="tag">${kjrEscape(x.category || 'Other')}</span></td>
      <td class="tl muted">${kjrEscape(x.subcategory || '')}</td>
      <td class="tl muted">${kjrEscape(x.merchant || '')}</td>
      <td class="tl muted">${kjrEscape(x.notes || '')}</td>
      <td class="row-actions"><button class="btn btn-sm btn-ghost btn-edit" data-edit-table="expenses" data-edit-id="${kjrEscape(x.id)}">Edit</button></td>
    </tr>`).join('')}</tbody></table></div>`;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   SUMMARY ROW helper
   ═══════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════
   DASHBOARD — net worth, allocation, cashflow. All computed in SGD, then
   fmt() converts to the dashboard tab's display currency.
   ═══════════════════════════════════════════════════════════════════════ */
function _stockMvSGD(){
  let mv = 0;
  (DB.stocks || []).forEach(s => {
    const ccy = s.currency || (s.market === 'SGX' ? 'SGD' : 'USD');
    const derived = deriveStockPosition(s.id);
    const shares  = derived ? derived.shares  : (s.shares  || 0);
    const avgCost = derived ? derived.avgCost : (s.avgCost || 0);
    const px = DB._priceCache[yahooSymbol(s)];
    if (px && px.price != null) mv += toSGD(px.price * shares, px.currency || ccy);
    else mv += toSGD(shares * avgCost, ccy); // fall back to cost basis
  });
  return mv;
}
/* Use the DERIVED balance (opening + movements + linked trade flows), the same
   figure the Cash tab shows, so net worth / allocation / EF never drift from it.
   Accounts whose currency has no known SGD rate are EXCLUDED from the total
   (never counted 1:1), so a stray foreign balance can't silently inflate net
   worth. excludedCount lets callers show a badge. */
function _cashSGDInfo(){
  let total = 0, excludedCount = 0;
  (DB.cash || []).forEach(c => {
    const sgd = sgdOrNull(deriveCashBalance(c), c.currency || 'SGD');
    if (sgd == null) excludedCount++;
    else total += sgd;
  });
  return { total, excludedCount };
}
function _cashSGD(){ return _cashSGDInfo().total; }
function _cpfSGD(){
  const e = cpfEffectiveBalances();
  return e.OA + e.SA + e.MA + e.RA;
}
function _realestateSGD(){ return (DB.realestate || []).reduce((s,r) => s + (Number(r.value)||0), 0); }
function _cryptoSGD(){
  let mv = 0;
  (DB.crypto || []).forEach(c => {
    const px = DB._priceCache[coinIdFor(c.coingeckoId || c.symbol)];
    if (px && px.sgd != null) mv += px.sgd * (Number(c.amount)||0);
    else mv += toSGD((Number(c.amount)||0) * (Number(c.avgCost)||0), c.currency || 'USD');
  });
  return mv;
}

function _cssVar(name){ return (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim() || '#888'; }

/* ─── Money integrity / reconciliation ─────────────────────────────────
   Surfaces places where double-entry is incomplete so no money silently
   appears or disappears: trades not funded from cash, negative balances
   (a missing deposit/transfer), and orphaned references to deleted records. */
function runReconciliation(){
  const issues = [];
  const cashIds  = new Set((DB.cash   || []).map(c => c.id));
  const stockIds = new Set((DB.stocks || []).map(s => s.id));

  const unlinked = (DB.stockTxns || []).filter(t => !t.cashAccountId);
  if (unlinked.length) issues.push({ level:'warn',
    msg: unlinked.length + ' stock trade' + (unlinked.length > 1 ? 's are' : ' is') + ' not funded from a cash account, so the matching cash movement is not tracked.' });

  let orphanCash = 0;
  (DB.cashTxns || []).forEach(t => {
    if (t.cashAccountId && !cashIds.has(t.cashAccountId)) orphanCash++;
    else if (t.type === 'transfer' && t.fromAccountId && !cashIds.has(t.fromAccountId)) orphanCash++;
  });
  if (orphanCash) issues.push({ level:'error',
    msg: orphanCash + ' cash movement' + (orphanCash > 1 ? 's reference' : ' references') + ' a deleted account.' });

  const orphanTradeIds = (DB.stockTxns || [])
    .filter(t => (t.stockId && !stockIds.has(t.stockId)) || (t.cashAccountId && !cashIds.has(t.cashAccountId)))
    .map(t => t.id);
  if (orphanTradeIds.length) issues.push({ level:'error', fixFn:'cleanOrphanedTrades',
    msg: orphanTradeIds.length + ' trade' + (orphanTradeIds.length > 1 ? 's reference' : ' references') + ' a deleted stock or cash account.' });

  (DB.cash || []).forEach(c => {
    const bal = deriveCashBalance(c);
    if (bal < -0.005) issues.push({ level:'warn',
      msg: (c.name || 'A cash account') + ' is negative (' + fmt(toSGD(bal, c.currency || 'SGD')) + '), so a deposit or transfer in is probably missing.' });
  });

  // Over-sold ledgers: a stock whose trades sell more shares than were ever
  // held. The position caps at zero, but realised P&L on the phantom shares is
  // misstated, so flag it for the user to correct the trade history.
  (DB.stocks || []).forEach(s => {
    const pos = deriveStockPosition(s.id);
    if (pos && pos.oversold > OVERSOLD_EPSILON) issues.push({ level:'warn',
      msg: (s.symbol || 'A stock') + "'s ledger sells " + (+pos.oversold.toFixed(4)) + ' more share' + (pos.oversold > 1 ? 's' : '') + ' than were held, so its realised P&L may be misstated. Check the trade history.' });
  });

  return { ok: issues.length === 0, issues };
}

/* Move every trade referencing a missing stock or cash account to trash.
   Wired to the "Remove orphaned" button in the integrity bar. */
function cleanOrphanedTrades(){
  const cashIds  = new Set((DB.cash   || []).map(c => c.id));
  const stockIds = new Set((DB.stocks || []).map(s => s.id));
  const orphans  = (DB.stockTxns || [])
    .filter(t => (t.stockId && !stockIds.has(t.stockId)) || (t.cashAccountId && !cashIds.has(t.cashAccountId)))
    .map(t => t.id);
  if (!orphans.length) return;
  const n = orphans.length;
  if (!confirm('Move ' + n + ' orphaned trade' + (n > 1 ? 's' : '') + ' to trash? You can restore from Settings → Recently deleted.')) return;
  orphans.forEach(id => sendToTrash('stockTxns', id));
  renderAll();
  showToast('Moved ' + n + ' orphaned trade' + (n > 1 ? 's' : '') + ' to trash', 'success');
}

/* Last n 'YYYY-MM' months ending with the current month. */
function _recentMonths(n){
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--){
    const dd = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(dd.getFullYear() + '-' + String(dd.getMonth() + 1).padStart(2, '0'));
  }
  return out;
}

/* ─── Net-worth snapshots ──────────────────────────────────────────────
   One row per day in DB.snapshots: { date:'YYYY-MM-DD', net, byClass:{...} }.
   takeSnapshot upserts today's row; autoSnapshot fires once per day on boot.
   Stored in SGD (the canonical base), converted at display time like all money. */
function _netWorthClassesSGD(){
  return {
    stocks:     _stockMvSGD(),
    cash:       _cashSGD(),
    cpf:        _cpfSGD(),
    realestate: _realestateSGD(),
    crypto:     _cryptoSGD()
  };
}
function currentNetWorthSGD(){
  const c = _netWorthClassesSGD();
  return c.stocks + c.cash + c.cpf + c.realestate + c.crypto;
}
function takeSnapshot(opts){
  opts = opts || {};
  if (!Array.isArray(DB.snapshots)) DB.snapshots = [];
  const byClass = _netWorthClassesSGD();
  const net = byClass.stocks + byClass.cash + byClass.cpf + byClass.realestate + byClass.crypto;
  const today = _isoDateSG(new Date());
  const existing = DB.snapshots.find(s => s.date === today);
  if (existing){
    existing.net = net; existing.byClass = byClass;
  } else {
    DB.snapshots.push({ id: uid('snap'), date: today, net, byClass });
  }
  DB.snapshots.sort((a,b) => String(a.date).localeCompare(String(b.date)));
  if (!opts.noSave) saveData();
  if (opts.rerender) renderDashboard();
  return net;
}
/* Auto-snapshot at most once per calendar day, and only when there's
   something to record (net worth > 0). Called on boot. */
function autoSnapshot(){
  if (currentNetWorthSGD() <= 0) return;
  const today = _isoDateSG(new Date());
  const has = (DB.snapshots || []).some(s => s.date === today);
  if (has) return;
  takeSnapshot({ noSave: true }); // boot already persists; avoid an extra sync
}

/* ── Dashboard arrange mode ─────────────────────────────────────────────── */
let _dashArrange  = false;
let _dashSortable = null;

function _applyDashLayout(){
  const stack = document.getElementById('dash-stack');
  if (!stack) return;
  const order = loadDashLayout();
  if (order.length){
    order.forEach(id => {
      const el = stack.querySelector(':scope > [data-wid="' + id + '"]');
      if (el) stack.appendChild(el);
    });
  }
  _dashDecorate();
  // Lazy-create sortable after stack exists.
  if (!_dashSortable && typeof KjrSortable !== 'undefined'){
    _dashSortable = KjrSortable.create(stack, {
      itemSelector:   '[data-wid]',
      handleSelector: '.kjr-drag-handle',
      idAttr:         'data-wid',
      enabled:        _dashArrange,
      onReorder: function(ids){ saveDashLayout(ids); }
    });
  }
}

function _dashDecorate(){
  const stack = document.getElementById('dash-stack');
  if (!stack) return;
  // Remove existing handles so re-decoration is idempotent.
  stack.querySelectorAll('.kjr-drag-handle').forEach(h => h.remove());
  if (!_dashArrange) return;
  stack.querySelectorAll(':scope > [data-wid]').forEach(function(el){
    if (!el.innerHTML.trim()) return; // skip empty blocks (CPF off, etc.)
    const h = document.createElement('div');
    h.className = 'kjr-drag-handle';
    h.title = 'Drag to reorder';
    h.innerHTML = '&#9776;'; // ☰ grip (positioning comes from the .dash-arranging CSS rule)
    el.appendChild(h);
  });
}

function toggleArrange(){
  _dashArrange = !_dashArrange;
  document.body.classList.toggle('dash-arranging', _dashArrange);
  if (_dashSortable){ _dashArrange ? _dashSortable.enable() : _dashSortable.disable(); }
  const btn = document.getElementById('dash-arrange-btn');
  if (btn) btn.textContent = _dashArrange ? 'Done' : 'Arrange';
  _dashDecorate();
}

/* ─── Hero monthly-change chip + sparkline ──────────────────────────────
   Both read the same DB.snapshots series renderDashboard already uses (one
   row/day: {date, net, byClass}). Pure presentation, no new stored figures. */
/* Latest snapshot vs the closest one at least 28 days older. Needs 2+
   qualifying snapshots or returns null (caller renders no chip at all, never
   an empty pill). netOf lets the caller pick full or ex-CPF net per row. */
function _heroMonthlyChange(snaps, netOf){
  if (!Array.isArray(snaps) || snaps.length < 2) return null;
  const sorted = snaps.slice().sort((a,b) => String(a.date).localeCompare(String(b.date)));
  const latest = sorted[sorted.length - 1];
  const latestMs = new Date(latest.date + 'T00:00:00').getTime();
  if (!isFinite(latestMs)) return null;
  let baseline = null;
  for (let i = sorted.length - 2; i >= 0; i--){
    const ms = new Date(sorted[i].date + 'T00:00:00').getTime();
    if (!isFinite(ms)) continue;
    const days = (latestMs - ms) / 86400000;
    if (days >= 28){ baseline = sorted[i]; break; }
  }
  if (!baseline) return null;
  const curNet = netOf(latest), baseNet = netOf(baseline);
  if (!isFinite(curNet) || !isFinite(baseNet) || baseNet === 0) return null;
  const pct = (curNet - baseNet) / Math.abs(baseNet) * 100;
  if (!isFinite(pct)) return null;
  return { pct };
}

/* Inline SVG polyline, ~150x52, from the same series (every point). Hidden
   entirely (caller returns '') when under 2 snapshots. Shape-only + aria-hidden,
   the numbers themselves live in the value/chip, not the sparkline. */
function _heroSparkline(snaps, netOf){
  if (!Array.isArray(snaps) || snaps.length < 2) return '';
  const sorted = snaps.slice().sort((a,b) => String(a.date).localeCompare(String(b.date)));
  const pts = sorted.map(s => netOf(s)).filter(v => isFinite(v));
  if (pts.length < 2) return '';
  const w = 150, h = 52, pad = 3;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = (max - min) || 1;
  const stepX = (w - pad*2) / (pts.length - 1);
  const coords = pts.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (v - min) / span) * (h - pad*2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  const last = coords[coords.length - 1].split(',');
  return `<svg class="dash-hero-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline points="${coords.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3" fill="var(--accent)"/>
  </svg>`;
}

function renderDashboard(){
  // Never reflow the stack mid-drag (a price refresh or stray event would
  // destroy the lifted card and leave it stuck).
  if (_dashSortable && _dashSortable.isDragging()) return;
  setRenderCcy('dashboard');
  const nwEl = document.getElementById('dash-networth');
  if (!nwEl) return;

  const cashInfo = _cashSGDInfo();
  const classes = [
    { key:'Stocks',      val:_stockMvSGD(),     color:'--accent' },
    { key:'Cash',        val:cashInfo.total,    color:'--blue'   },
    { key:'CPF',         val:_cpfSGD(),         color:'--green'  },
    { key:'Real Estate', val:_realestateSGD(),  color:'--amber'  }
  ];
  const crypto = _cryptoSGD();
  if (crypto > 0) classes.push({ key:'Crypto', val:crypto, color:'--accent2' });
  const netFull   = roundMoney(classes.reduce((s,c) => s + c.val, 0));
  const cpfVal    = _cpfSGD();
  const netExCpf  = roundMoney(netFull - cpfVal);

  // displayClasses + displayNet respect the CPF toggle
  const displayClasses = _dashShowCpf ? classes : classes.filter(c => c.key !== 'CPF');
  const displayNet     = _dashShowCpf ? netFull : netExCpf;

  // Net worth hero — secondary (ex-CPF) only shown when CPF is on
  const heroSecondary = _dashShowCpf
    ? `<div style="width:1px;height:48px;background:var(--border);align-self:center;flex-shrink:0"></div>
    <div><div class="dash-hero-label">Ex-CPF</div><div class="dash-hero-value" style="font-size:28px;color:var(--text2)">${fmt(netExCpf, {dp:0})}</div></div>`
    : '';
  const fxExclusionNote = cashInfo.excludedCount
    ? `<div class="dash-hero-label" style="margin-top:4px">Excludes ${cashInfo.excludedCount} cash account${cashInfo.excludedCount>1?'s':''} with missing FX, refresh FX in Settings</div>`
    : '';

  // Monthly change chip: latest snapshot vs the closest one >=28 days older,
  // in the same full/ex-CPF terms as the headline figure. No chip at all
  // (not an empty pill) when fewer than 2 qualifying snapshots exist.
  const snaps = DB.snapshots || [];
  const netOf = s => _dashShowCpf ? s.net : (s.net - ((s.byClass && s.byClass.cpf) || 0));
  const change = _heroMonthlyChange(snaps, netOf);
  const changeChip = change
    ? `<span class="dash-hero-chip ${change.pct >= 0 ? 'pos' : 'neg'}">${change.pct >= 0 ? '▲' : '▼'} ${change.pct >= 0 ? '+' : ''}${change.pct.toFixed(1)}% this month</span>`
    : '';
  const spark = _heroSparkline(snaps, netOf);

  // Subline: current CPF-toggle wording plus the sync status (kept in step by
  // setSyncStatus, which also writes #dash-hero-sync directly on every sync
  // event; this initial value covers the render that creates the element).
  const syncText = document.getElementById('sync-pill-label')
    ? document.getElementById('sync-pill-label').textContent
    : 'Local only';
  const subline = `CPF ${_dashShowCpf ? 'on' : 'off'} · <span id="dash-hero-sync">${kjrEscape(syncText)}</span>`;

  nwEl.innerHTML = `<div class="dash-hero">
    <div><div class="dash-hero-label">${_dashShowCpf ? 'Net worth (with CPF)' : 'Net worth (ex-CPF)'}${changeChip}</div><div class="dash-hero-value">${fmt(displayNet, {dp:0})}</div><div class="dash-hero-sub">${subline}</div>${fxExclusionNote}</div>
    ${heroSecondary}
    ${spark}
    <button style="${spark ? '' : 'margin-left:auto;'}flex-shrink:0" class="btn btn-sm${_dashShowCpf ? ' btn-active' : ''}" data-click="toggleDashCpf" title="${_dashShowCpf ? 'Click to exclude CPF from net worth' : 'Click to include CPF in net worth'}">CPF ${_dashShowCpf ? 'on' : 'off'}</button>
  </div>`;

  // Data integrity / reconciliation — ok state is a pill in the page-head,
  // bad state is a full bar below the hero (needs room for the issues list).
  const intPill = document.getElementById('dash-integrity-pill');
  const intEl   = document.getElementById('dash-integrity');
  const rec = runReconciliation();
  if (rec.ok){
    if (intPill) intPill.innerHTML = `<span class="integrity-pill">✓ Books balanced</span>`;
    if (intEl)   intEl.innerHTML   = '';
  } else {
    if (intPill) intPill.innerHTML = '';
    if (intEl)   intEl.innerHTML   = `<div class="integrity-bar bad">
      <div class="integrity-title">⚠ ${rec.issues.length} thing${rec.issues.length > 1 ? 's' : ''} to check</div>
      <ul class="integrity-list">${rec.issues.map(i =>
        `<li class="${i.level}">${kjrEscape(i.msg)}${i.fixFn
          ? ` <button class="btn btn-sm btn-danger" style="margin-left:8px;padding:1px 8px;font-size:12px" data-click="callFixFn" data-a0="${kjrEscape(i.fixFn)}">Remove orphaned</button>`
          : ''}</li>`
      ).join('')}</ul>
    </div>`;
  }

  // Asset-class cards + allocation bar. One small card per class (icon chip,
  // value, share of net worth), a segmented proportion bar, and a $ + %
  // legend that always lists every class regardless of slice size. When CPF
  // is toggled off it is excluded entirely, like everywhere else on the
  // dashboard. Icons reuse the exact SVGs from TABS (Stocks/Cash/CPF/Real
  // Estate) rather than inventing new artwork.
  const CLASS_ICON = {
    Stocks: TABS.find(t => t.key === 'stocks').icon,
    Cash:   TABS.find(t => t.key === 'cash').icon,
    CPF:    TABS.find(t => t.key === 'cpf').icon,
    'Real Estate': TABS.find(t => t.key === 'realestate').icon,
    Crypto: TABS.find(t => t.key === 'crypto').icon
  };
  const assetsEl = document.getElementById('dash-assets');
  if (assetsEl){
    if (netFull <= 0){
      assetsEl.innerHTML = `<div class="card" style="margin-top:16px"><div class="card-body"><div class="empty"><div class="empty-icon">📊</div><div class="empty-title">No holdings yet</div><div class="empty-sub">Add stocks, cash, CPF, or property and your net worth and allocation appear here.</div></div></div></div>`;
    } else {
      const segs = displayClasses.filter(c => c.val > 0);
      const pctOf = c => displayNet > 0 ? (c.val / displayNet * 100) : 0;
      const classCards = segs.map(c => {
        const p = pctOf(c);
        return `<div class="dash-class-card">
          <div class="dash-class-icon" style="background:var(${c.color}-soft,var(${c.color}));color:var(${c.color})">${CLASS_ICON[c.key] || ''}</div>
          <div class="dash-class-value metric-value">${fmt(c.val,{dp:0})}</div>
          <div class="dash-class-label">${kjrEscape(c.key)} · ${p.toFixed(0)}%</div>
        </div>`;
      }).join('');
      const bar = segs.map(c => {
        const p = pctOf(c);
        return `<div class="alloc-seg" style="flex:${c.val};background:var(${c.color})" title="${kjrEscape(c.key)} · ${fmt(c.val,{dp:0})} (${p.toFixed(0)}%)"></div>`;
      }).join('');
      const legend = segs.map(c => {
        const p = pctOf(c);
        return `<div class="alloc-legend-item"><span class="alloc-legend-dot" style="background:var(${c.color})"></span>${kjrEscape(c.key)} <span class="alloc-legend-amt">${fmt(c.val,{dp:0})}</span> <span class="alloc-legend-pct">${p.toFixed(0)}%</span></div>`;
      }).join('');
      assetsEl.innerHTML = `<div class="dash-class-grid" style="margin-top:16px">${classCards}</div><div class="card"><div class="card-body"><div class="alloc-bar">${bar}</div><div class="alloc-legend">${legend}</div></div></div>`;
    }
  }

  // CPF breakdown
  const cpfEl = document.getElementById('dash-cpf');
  if (cpfEl){
    const bal = cpfEffectiveBalances();
    const cpfTotal = bal.OA + bal.SA + bal.MA + bal.RA;
    if (_dashShowCpf && cpfTotal > 0){
      cpfEl.innerHTML = `<div class="card" style="margin-top:16px"><div class="card-head"><h3>CPF breakdown</h3></div><div class="card-body">` +
        renderSummary([
          { label:'OA', value: fmt(bal.OA, {dp:0}), accent:'accent' },
          { label:'SA', value: fmt(bal.SA, {dp:0}) },
          { label:'MA', value: fmt(bal.MA, {dp:0}) },
          { label:'RA', value: fmt(bal.RA, {dp:0}) }
        ]) + `</div></div>`;
    } else {
      cpfEl.innerHTML = '';
    }
  }

  // Emergency fund progress
  renderEmergencyFund();
  // Target allocation: always use full picture (planning tool; CPF is a real asset class)
  renderTargetAllocation(classes, netFull);
  // Top movers (today's gainers/losers)
  renderTopMovers();

  // Charts only when the tab is visible (Chart.js needs a sized canvas).
  const visible = document.getElementById('page-dashboard').classList.contains('active');
  if (visible && typeof Chart !== 'undefined'){
    renderChartBuilder();   // Chart Builder card + seeded + saved charts (also calls _applyDashLayout)
  } else {
    _applyDashLayout();
  }
  // Show Arrange button once content is present.
  const arrangeBtn = document.getElementById('dash-arrange-btn');
  if (arrangeBtn) arrangeBtn.style.display = '';
}

/* ─── Emergency fund widget ─────────────────────────────────────────────
   Tracks cash + savings against a target. Cash only (not CPF/stocks), since
   an emergency fund is liquid by definition. */
function renderEmergencyFund(){
  const el = document.getElementById('dash-ef');
  if (!el) return;
  const target = Number(DB.settings.efTarget) || 0;
  if (target <= 0){ el.innerHTML = ''; return; }
  const cash = _cashSGD();
  const pct = target > 0 ? Math.min(100, cash / target * 100) : 0;
  const done = cash >= target;
  const barColor = done ? 'var(--green)' : (pct >= 50 ? 'var(--amber)' : 'var(--red)');
  el.innerHTML = `<div class="card" style="margin-top:16px"><div class="card-head">
      <h3>Emergency fund</h3>
      <span class="hint">${done ? 'fully funded' : fmt(target - cash, {dp:0}) + ' to go'}</span>
    </div><div class="card-body">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <span style="font-size:18px;font-weight:700;font-variant-numeric:tabular-nums">${fmt(cash, {dp:0})}</span>
        <span class="hint">of ${fmt(target, {dp:0})} target · ${pct.toFixed(0)}%</span>
      </div>
      <div style="height:10px;background:var(--bg3);border-radius:6px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${barColor};transition:width .3s"></div>
      </div>
    </div></div>`;
}

/* ─── Target allocation + rebalancing ──────────────────────────────────
   Compares current allocation against DB.settings.targets and flags any
   class that has drifted more than the rebalance threshold off target. */
function renderTargetAllocation(classes, net){
  const el = document.getElementById('dash-targets');
  if (!el) return;
  const t = DB.settings.targets || {};
  const targetSum = (Number(t.stocks)||0)+(Number(t.cash)||0)+(Number(t.cpf)||0)+(Number(t.realestate)||0)+(Number(t.crypto)||0);
  if (targetSum <= 0 || net <= 0){ el.innerHTML = ''; return; }

  const keyMap = { Stocks:'stocks', Cash:'cash', CPF:'cpf', 'Real Estate':'realestate', Crypto:'crypto' };
  const thr = Number(DB.settings.rebalanceThreshold) || 5;
  const rows = [];
  const alerts = [];
  classes.forEach(c => {
    const k = keyMap[c.key];
    const tgt = Number(t[k]) || 0;
    if (tgt <= 0 && c.val <= 0) return;
    const cur = net > 0 ? c.val / net * 100 : 0;
    const drift = cur - tgt;
    const off = Math.abs(drift) > thr;
    rows.push({ key:c.key, color:c.color, cur, tgt, drift, off });
    if (off) alerts.push({ key:c.key, drift, tgt, cur,
      action: drift > 0 ? 'trim' : 'top up' });
  });
  if (!rows.length){ el.innerHTML = ''; return; }

  const bars = rows.map(r => {
    const driftTxt = (r.drift >= 0 ? '+' : '') + r.drift.toFixed(0) + ' pts';
    const driftCls = r.off ? (r.drift > 0 ? 'neg' : 'pos') : '';
    return `<div class="alloc-row">
      <div style="font-weight:600">${kjrEscape(r.key)}</div>
      <div class="alloc-bar">
        <div class="alloc-fill" style="width:${Math.min(100,r.cur)}%;background:${_cssVar(r.color)}"></div>
        <div class="alloc-target" style="left:${Math.min(100,r.tgt)}%" title="target ${r.tgt.toFixed(0)}%"></div>
      </div>
      <div class="num" style="min-width:54px">${r.cur.toFixed(0)}%</div>
      <div class="hint" style="min-width:64px;text-align:right">tgt ${r.tgt.toFixed(0)}%</div>
      <div class="num ${driftCls}" style="min-width:64px">${driftTxt}</div>
    </div>`;
  }).join('');

  const alertHtml = alerts.length
    ? `<div class="rebal-alerts">${alerts.map(a =>
        `<div class="rebal-alert"><b>${kjrEscape(a.key)}</b> is ${Math.abs(a.drift).toFixed(0)} pts ${a.drift>0?'over':'under'} target, consider ${a.action === 'trim' ? 'trimming' : 'topping up'}.</div>`
      ).join('')}</div>`
    : `<div class="integrity-bar ok" style="margin-top:12px">✓ Allocation is within ${thr} pts of every target.</div>`;

  el.innerHTML = `<div class="card" style="margin-top:16px"><div class="card-head">
      <h3>Target allocation</h3><span class="hint">current vs target · ${thr} pt tolerance · set in Settings</span>
    </div><div class="card-body">${bars}${alertHtml}</div></div>`;
}

/* ─── Top movers ───────────────────────────────────────────────────────
   Today's biggest stock movers by % change (last price vs prevClose from the
   price cache). Crypto uses 24h change. Skips holdings with no fresh price. */
function renderTopMovers(){
  const el = document.getElementById('dash-movers');
  if (!el) return;
  const movers = [];
  (DB.stocks || []).forEach(s => {
    const px = DB._priceCache[yahooSymbol(s)];
    if (!px || px.price == null || px.previousClose == null || !px.previousClose) return;
    const chgPct = (px.price - px.previousClose) / px.previousClose * 100;
    if (!isFinite(chgPct)) return;
    movers.push({ label: (s.symbol||'').toUpperCase(), sub:'stock', chgPct, price: px.price, ccy: px.currency || s.currency || 'USD' });
  });
  (DB.crypto || []).forEach(c => {
    const px = DB._priceCache[coinIdFor(c.coingeckoId || c.symbol)];
    if (!px || px.change24h == null) return;
    const chgPct = Number(px.change24h);
    if (!isFinite(chgPct)) return;
    movers.push({ label: (c.symbol||'').toUpperCase(), sub:'crypto', chgPct, price: px.sgd, ccy:'SGD' });
  });
  if (!movers.length){ el.innerHTML = ''; return; }
  movers.sort((a,b) => Math.abs(b.chgPct) - Math.abs(a.chgPct));
  const top = movers.slice(0, 6);
  const cells = top.map(m => {
    const up = m.chgPct >= 0;
    const cls = up ? 'pos' : 'neg';
    const arrow = up ? '▲' : '▼';
    return `<div class="mover">
      <div class="mover-sym">${kjrEscape(m.label)} <span class="hint">${m.sub}</span></div>
      <div class="mover-px num">${fmt(m.price, { currency: m.ccy, dp:0 })}</div>
      <div class="mover-chg num ${cls}">${arrow} ${(up?'+':'')}${m.chgPct.toFixed(1)}%</div>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="card" style="margin-top:16px"><div class="card-head">
      <h3>Top movers</h3><span class="hint">today · by % change</span>
    </div><div class="card-body"><div class="movers-grid">${cells}</div></div></div>`;
}

function renderSummary(items){
  return `<div class="h-summary">${
    items.map(it => `
      <div class="h-summary-item ${it.accent || ''}">
        <div class="h-summary-label">${kjrEscape(it.label)}</div>
        ${it.value ? `<div class="h-summary-value">${it.value}</div>` : ''}
        ${it.sub ? `<div class="h-summary-sub">${it.sub}</div>` : ''}
      </div>`).join('')
  }</div>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   RENDER ALL — top-level redraw
   ═══════════════════════════════════════════════════════════════════════ */
function renderAll(){
  // Preserve scroll position: renderAll rebuilds table innerHTML, which would
  // otherwise jump the page to the top on a background sync or cross-tab update.
  // Navigation scroll-to-top is handled separately in showPage().
  const sx = window.scrollX, sy = window.scrollY;
  updateCcyToggleUI();
  renderDashboard();
  renderStocks();
  renderCrypto();
  renderRealestate();
  renderCash();
  renderCpf();
  renderCashflow();
  if (document.getElementById('page-settings').classList.contains('active')) {
    loadSettingsForm();
    renderDiagnostics();
  }
  if (window.scrollTo) window.scrollTo(sx, sy);
}

/* ═══════════════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════════════ */
/* Delegated click handler for Edit buttons.
   We no longer inline data-click="openEntity" data-a0="table" data-a1="${id}" because that
   interpolates user-supplied data into a JS context — even with ids validated
   on save, defence-in-depth says don't put untrusted data into JS strings.
   Instead, the buttons carry data-edit-table + data-edit-id. The handler
   re-validates the id with kjrSafeId before dispatching.
   This listener attaches once at boot and survives every re-render. */
function installEventDelegation(){
  document.addEventListener('click', (e) => {
    const bTh = e.target.closest('th[data-board-sort-key]');
    if (bTh){ setBoardSort(bTh.getAttribute('data-board-sort-key')); return; }
    const wlTh = e.target.closest('th[data-wl-sort-key]');
    if (wlTh){ setWatchlistSort(wlTh.getAttribute('data-wl-sort-key')); return; }
    const th = e.target.closest('th[data-sort-key]');
    if (th){ setStockSort(th.getAttribute('data-sort-key')); return; }
    const btn = e.target.closest('[data-edit-table][data-edit-id]');
    if (!btn) return;
    const table = btn.getAttribute('data-edit-table');
    const id    = btn.getAttribute('data-edit-id');
    if (!ENTITY_SCHEMAS[table]) return;
    if (!kjrSafeId(id)) { showToast('Invalid entry id', 'error'); return; }
    openEntityModal(table, id);
  });
  // More sheet (mobile): Escape closes it, matching the entity/columns modals.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const sheet = document.getElementById('more-sheet');
    if (sheet && sheet.classList.contains('open')) closeMoreSheet();
  });
  // Undo / Redo — skip when focus is inside a text field (let browser handle).
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const inField = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
    if (mod && !inField){
      if (e.key === 'z' && !e.shiftKey){ e.preventDefault(); undoAction(); return; }
      if (e.key === 'y' || (e.key === 'z' && e.shiftKey)){ e.preventDefault(); redoAction(); return; }
    }
  });
  // Keyboard sort: sortable headers are tabbable, Enter/Space toggles.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const bTh = e.target && e.target.closest ? e.target.closest('th[data-board-sort-key]') : null;
    if (bTh){ e.preventDefault(); setBoardSort(bTh.getAttribute('data-board-sort-key')); return; }
    const wlTh = e.target && e.target.closest ? e.target.closest('th[data-wl-sort-key]') : null;
    if (wlTh){ e.preventDefault(); setWatchlistSort(wlTh.getAttribute('data-wl-sort-key')); return; }
    const th = e.target && e.target.closest ? e.target.closest('th[data-sort-key]') : null;
    if (!th) return;
    e.preventDefault();
    setStockSort(th.getAttribute('data-sort-key'));
  });

  // ── Delegated action dispatch (CSP: no inline handlers) ────────────────────
  // Every former inline on* handler now carries data-click / data-change /
  // data-input (plus data-a0..a2 for arguments). One set of document-level
  // listeners dispatches them via the ACTIONS map, which is what lets us drop
  // script-src 'unsafe-inline'. Arguments that are entity ids are re-validated
  // with kjrSafeId before use, mirroring the data-edit-id path above.
  const A = (el) => [el.getAttribute('data-a0'), el.getAttribute('data-a1'), el.getAttribute('data-a2')];
  const ACTIONS = {
    // navigation / theme / currency
    navigate:            (el) => navigate(A(el)[0]),
    openMoreSheet:       () => openMoreSheet(),
    closeMoreSheet:      () => closeMoreSheet(),
    toggleTheme:         () => toggleTheme(),
    togglePrivacy:       () => togglePrivacy(),
    setThemeChoice:      (el) => setThemeChoice(A(el)[0]),
    setDisplayCcy:       (el) => setDisplayCcy(A(el)[0]),
    // entity modals
    openEntity:          (el) => { const [a0, a1] = A(el); if (a1 != null && !kjrSafeId(a1)) { showToast('Invalid entry id', 'error'); return; } openEntityModal(a0, a1 == null ? undefined : a1); },
    closeEntityModal:    () => closeEntityModal(),
    entityModalSave:     () => entityModalSave(),
    entityModalDelete:   () => entityModalDelete(),
    // settings / sync
    saveSettings:        () => saveSettingsFromForm(),
    saveSyncUrl:         () => saveSyncUrlFromForm(),
    saveSalaryRules:     () => saveSalaryRulesFromForm(),
    saveCpfBalances:     () => saveCpfBalancesFromForm(),
    toggleSyncUrlReveal: () => toggleSyncUrlReveal(),
    manualSync:          () => manualSync(),
    manualPush:          () => manualPush(),
    manualPull:          () => manualPull(),
    refreshFx:           () => refreshFx(),
    testPriceFetch:      () => testPriceFetch(),
    renderDiagnostics:   () => renderDiagnostics(),
    resetLocalConfirm:   () => resetLocalConfirm(),
    dismissConflict:     () => { const m = document.getElementById('conflict-modal'); if (m) m.remove(); setSyncStatus('failed', 'Conflict unresolved'); },
    setStrictConflicts:  (el) => setStrictConflicts(el.checked),
    setAutoRefreshEnabled: (el) => setAutoRefreshEnabled(el.checked),
    // prices
    refreshStockPrices:  () => refreshStockPrices(),
    refreshCryptoPrices: () => refreshCryptoPrices(),
    // stocks table paging / filtering / ledger
    stocksPrevPage:      () => { _stocksPage--; renderStocks(); },
    stocksNextPage:      () => { _stocksPage++; renderStocks(); },
    stocksClearFilter:   () => { _stocksFilter = { sector:'', market:'' }; _stocksPage = 0; renderStocks(); },
    stocksFilterSector:  (el) => { _stocksFilter.sector = el.value; _stocksPage = 0; renderStocks(); },
    stocksFilterMarket:  (el) => { _stocksFilter.market = el.value; _stocksPage = 0; renderStocks(); },
    ledgerViewFlat:      () => { _ledgerView = 'flat'; renderStockTxns(); },
    ledgerViewByStock:   () => { _ledgerView = 'by-stock'; renderStockTxns(); },
    // dashboard
    toggleDashCpf:       () => { _dashShowCpf = !_dashShowCpf; renderDashboard(); },
    toggleArrange:       () => toggleArrange(),
    // columns manager
    openStockColumns:    () => openStockColumns(),
    closeStockColumns:   () => closeStockColumns(),
    resetStockColumns:   () => resetStockColumns(),
    openColumns:         (el) => openColumns(A(el)[0]),
    closeColumns:        (el) => closeColumns(A(el)[0]),
    resetColumns:        (el) => resetColumns(A(el)[0]),
    toggleCol:           (el) => { const [a0, a1] = A(el); toggleCol(a0, a1); },
    moveCol:             (el) => { const [a0, a1, a2] = A(el); moveCol(a0, a1, Number(a2)); },
    // setup wizard
    openSetupWizard:     () => openSetupWizard(),
    closeSetupWizard:    () => closeSetupWizard(),
    setupWizardNext:     () => setupWizardNext(),
    setupWizardBack:     () => setupWizardBack(),
    // salary rules / P&L
    addSalaryRule:       () => addSalaryRule(),
    removeSalaryRule:    (el) => removeSalaryRule(Number(A(el)[0])),
    onSalaryRuleInput:   () => onSalaryRuleInput(),
    updateTargetSumHint: () => updateTargetSumHint(),
    renderTaxEstimate:   () => renderTaxEstimate(),
    renderCpf:           () => renderCpf(),
    renderCashflow:      () => renderCashflow(),
    // trash
    restoreFromTrash:    (el) => { const id = A(el)[0]; if (!kjrSafeId(id)) { showToast('Invalid entry id', 'error'); return; } restoreFromTrash(id); },
    purgeTrashItem:      (el) => { const id = A(el)[0]; if (!kjrSafeId(id)) { showToast('Invalid entry id', 'error'); return; } purgeTrashItem(id); },
    emptyTrash:          () => emptyTrash(),
    // import / export / backup
    exportBackup:        () => exportBackup(),
    exportHoldingsCSV:   () => exportHoldingsCSV(),
    exportLedgerCSV:     () => exportLedgerCSV(),
    clickImportFile:     () => { const i = document.getElementById('import-file-input'); if (i) i.click(); },
    importBackupFromFile: (el) => importBackupFromFile(el),
    clickIbkrFile:       () => { const i = document.getElementById('ibkr-file-input'); if (i) i.click(); },
    ibkrFileSelected:    (el) => ibkrFileSelected(el),
    ibkrConfirmImport:   () => ibkrConfirmImport(),
    closeIbkrPreview:    () => { const o = document.getElementById('ibkr-preview-overlay'); if (o) o.classList.remove('open'); },
    // chart builder
    pbRenderChart:       () => pbRenderChart(),
    pbSaveChart:         () => pbSaveChart(),
    pbResetChart:        () => pbResetChart(),
    pbSetMode:           (el) => pbSetMode(A(el)[0]),
    pbSetPeriod:         (el) => pbSetPeriod(A(el)[0]),
    pbSetSource:         (el) => pbSetSource(el.value),
    pbSetSeriesView:     (el) => pbSetSeriesView(el.value),
    pbSetSeriesClass:    (el) => pbSetSeriesClass(el.value),
    pbSetTsValue:        (el) => { pbState.tsValue = el.value; _pbSaveState(); pbRenderChart(); },
    pbToggleAvgCost:     (el) => { pbState.tsAvgCost = el.checked; _pbSaveState(); pbRenderChart(); },
    pbToggleSymbol:      (el) => pbToggleSymbol(el.value, el.checked),
    pbFilterPalette:     (el) => pbFilterPalette(el.value),
    pbAssignField:       (el) => pbAssignField(A(el)[0]),
    pbRemoveField:       (el) => { const [a0, a1] = A(el); pbRemoveField(a0, a1); },
    pbTogglePin:         (el) => pbTogglePin(A(el)[0]),
    pbRefreshSaved:      (el) => pbRefreshSaved(A(el)[0]),
    pbDeleteSaved:       (el) => pbDeleteSaved(A(el)[0]),
    // misc
    overlayBackdropClose: (el, ev) => { if (ev.target === el) el.classList.remove('open'); },
    callFixFn:           (el) => { const fn = window[A(el)[0]]; if (typeof fn === 'function') fn(); },
  };
  function runAction(attr, el, ev){
    const fn = ACTIONS[el.getAttribute(attr)];
    if (fn) fn(el, ev);
  }
  document.addEventListener('click',  (e) => { const el = e.target.closest('[data-click]');  if (el) runAction('data-click', el, e); });
  document.addEventListener('change', (e) => { const el = e.target.closest('[data-change]'); if (el) runAction('data-change', el, e); });
  document.addEventListener('input',  (e) => { const el = e.target.closest('[data-input]');  if (el) runAction('data-input', el, e); });
  // Chart-builder drag and drop. The tap fallback is data-click="pbAssignField".
  document.addEventListener('dragstart', (e) => {
    const el = e.target.closest('[data-drag-key]');
    if (el) e.dataTransfer.setData('text/plain', el.getAttribute('data-drag-key'));
  });
  document.addEventListener('dragover', (e) => {
    const z = e.target.closest('[data-drop]');
    if (z){ e.preventDefault(); z.classList.add('drag-over'); }
  });
  document.addEventListener('dragleave', (e) => {
    const z = e.target.closest('[data-drop]');
    if (z) z.classList.remove('drag-over');
  });
  document.addEventListener('drop', (e) => {
    const z = e.target.closest('[data-drop]');
    if (z){ e.preventDefault(); z.classList.remove('drag-over'); pbDrop(z.getAttribute('data-drop'), e.dataTransfer.getData('text/plain')); }
  });
}

async function boot(){
  applyTheme(localStorage.getItem(LK_THEME) || 'dark');
  applyPrivacy(privacyOn());
  // Stamp display version into the logo (matches Collectibles app-ver format)
  const verEl = document.getElementById('logo-version');
  if (verEl) verEl.textContent = APP_DISPLAY_VERSION;
  renderNav();
  installEventDelegation();
  installAutoRefreshVisibility();
  // ── 1. First paint from cached local data ─────────────────────────────────
  // Render immediately so the app is interactive fast. The heavy salary/snapshot
  // engines and the network pull are deferred below — neither blocks first paint.
  const had = loadLocal();
  if (!had) saveLocal(); // seed empty DB so localStorage has the canonical shape
  migrateDeviceLocalChartState(); // D1: one-time pickup of the old localStorage chart/layout keys
  updateCcyToggleUI();
  renderAll();
  if (!location.hash) history.replaceState(null, '', '#dashboard'); // seed without an extra entry
  route();               // hash is the source of truth (supports deep links like #stocks)
  updateSyncStatusPill();

  // ── 2. Defer heavy compute engines to idle ────────────────────────────────
  // runSalaryEngine + autoSnapshot read and write the DOM, so they must stay on
  // the main thread (a Web Worker has no DOM) — but they run after first paint,
  // off the critical path, so they no longer delay Time to Interactive.
  whenIdle(() => {
    runSalaryEngine({ notify: true }); // backfill auto income + CPF
    autoSnapshot();                    // record today's net worth (once/day)
    renderAll();                       // reflect the backfill (scroll is preserved)
  });

  // ── 3. Stale-while-revalidate network sync ─────────────────────────────────
  // Cached data is already on screen. pullFromRemote() shows the syncing pill,
  // reconciles the DOM on resolve, and sets synced/failed itself, so we fire it
  // in the background rather than awaiting it (no stall on a slow connection).
  if (getSyncUrl()) {
    if (navigator.onLine) {
      revalidateFromRemote({ allowSeed: true });
      startAutoRefresh();
    } else {
      // Offline: stay on the cached dashboard, then catch up once back online.
      updateSyncStatusPill();
      window.addEventListener('online', () => {
        revalidateFromRemote({ allowSeed: true });
        startAutoRefresh();
      }, { once: true });
    }
  } else if (navigator.onLine) {
    // First-launch onboarding configures a backend, so it needs the network.
    maybeShowWizardOnBoot();
  }
}

/* Run after first paint when the main thread is idle; falls back to a macrotask
   where requestIdleCallback is unavailable (e.g. older Safari). */
function whenIdle(fn){
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 1);
}

/* Background revalidation for the stale-while-revalidate boot path. The syncing
   pill and the DOM reconcile are handled inside pullFromRemote(); we only chain
   the salary re-run because the remote payload may carry updated salary config. */
function revalidateFromRemote(opts){
  return pullFromRemote(opts).then(ok => { if (ok) runSalaryEngine({ rerender: true }); });
}

document.addEventListener('DOMContentLoaded', boot);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
