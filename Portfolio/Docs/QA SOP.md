# Kujira Portfolio, QA Runbook v2

How to QA this app after any change, and the mistakes that must never come back.
Re-run the whole thing whenever a new feature touches money, display, or storage.

Supersedes `QA SOP v1 (4 Jun)`. Last updated: 03/07/2026 (app v2.38).

---

## How to run a QA pass

1. **Start the preview.** Launch config `kjr-portfolio` (global `.claude/launch.json`), serves
   the repo root on port 3807. The app lives at `http://localhost:3807/Portfolio/`, not the
   repo root (the root 404s by design, that is expected).
2. **Run the automated checks first** (cheap, catches regressions before you open a browser):
   - `npm test` from `Portfolio/`, runs `tests/test-core.js` (money/date/CPF/tax/seed-guard
     unit tests) then `tests/check-release.js` (cache-bust discipline, see below). Both must
     be green before any manual pass.
   - Static scan for dead buttons: `grep -oE "^function [a-zA-Z0-9_]+" index.html | sort | uniq -d`
     (expect blank, no duplicate top-level defs).
   - Every inline `onclick`/`oninput`/`onchange` handler resolves to a defined function
     (`document.*` calls are false positives, ignore).
3. **Seed a representative dataset** in the browser console (paste directly, do NOT type into
   prod). localhost has no sync URL stored so cloud sync stays off automatically, never paste
   the production Apps Script URL into a localhost session:

```js
(() => { const seed = freshDB();
seed.settings.fxOverrides.USDSGD = 1.35; seed.settings.birthYear = 1995;
seed.settings.targets = { stocks:40, cash:20, cpf:30, realestate:10, crypto:0 };
seed.settings.efTarget = 30000;
seed.settings.salary = { employer:'Acme Pte Ltd', grossMonthly:8000, startDate:'2026-01-01', endDate:null, annualBonus:8000, bonusMonth:12 };
seed.settings.salarySavePct = 50; seed.settings.salaryCashEnabledAt = '2026-01-01';
seed.settings.salaryAccountId = 'cash_seed_dbs';
seed.cash = [ { id:'cash_seed_dbs', name:'DBS Multiplier', account:'Savings', amount:20000, asOf:'2025-12-31', currency:'SGD', apy:1.8 }, { id:'cash_seed_ibkr', name:'IBKR USD', account:'Brokerage', amount:0, asOf:'2025-12-31', currency:'USD' } ];
seed.stocks = [ { id:'stock_seed_aapl', symbol:'AAPL', market:'US', sector:'Information Technology', shares:30, avgCost:150, currency:'USD', divPerShare:1.00 }, { id:'stock_seed_d05', symbol:'D05', market:'SGX', sector:'Financials', shares:100, avgCost:30, currency:'SGD' } ];
seed.stockTxns = [ { id:'txn_seed_sell', stockId:'stock_seed_aapl', date:'2026-03-10', side:'sell', shares:10, price:290, fees:5, cashAccountId:'cash_seed_ibkr' } ];
seed.realestate = [ { id:'re_seed_hdb', name:'HDB Punggol', value:500000, currency:'SGD' } ];
seed.cpfBalances = { OA:40000, SA:20000, MA:15000, RA:0, updatedAt:new Date().toISOString(), anchorDate:'2025-12-31' };
DB = mergeDefaults(seed); saveLocal(); runSalaryEngine({}); renderAll(); })()
```

4. **Assert numbers, do not eyeball.** Pull computed values via eval and check them against
   the invariant table below. Screenshots are for layout, not for accuracy.
5. **Walk every tab**: Dashboard, Stocks, Cash, CPF, P&L, Real Estate, Settings. Check
   golden path + empty state + both themes (dark default, warm light opt-in) + both currencies
   (SGD/USD) + mobile widths (430, 390, 375).
6. **Check the console on every tab.** Zero errors is the bar.
7. **Reset to a clean first-run state** when done: `localStorage.clear(); location.reload()`.
   Never leave seed data behind.

---

## Invariants this seed must always produce (as of Jul 2026, 6 paydays elapsed)

| Check | Expected |
|---|---|
| AAPL position | 20 shares, avg cost 150, realised P&L US$1,395 |
| DBS balance | 39,200 (20,000 + 6 x 3,200 salary deposits) |
| IBKR balance | US$2,895, S$3,908.25 |
| CPF effective | OA 51,040 / SA 22,880 / MA 18,840, total 92,760 |
| Net worth (with CPF) | S$642,918 |
| Net worth (ex-CPF) | S$550,158 |
| Net worth in USD | US$476,236 |
| Reconciliation | `runReconciliation().ok === true` |

---

## Money invariants (must always hold)

These are the checks that catch finance bugs. Add a new one whenever a feature adds a number.

- **Dashboard cash == Cash tab total.** Both must use `deriveCashBalance()` (opening +
  movements + linked trade flows). The 04/06 bug was `_cashSGD()` reading the raw `amount`
  field, understating net worth by any brokerage trade proceeds.
- **Net worth == sum of the asset-class cards.** Stocks + Cash + CPF + Real Estate + Crypto.
- **Stocks: market value minus total cost == unrealised P&L.** Realised P&L comes only from sells.
- **Partial sell maths.** Open 30 @150, sell 10 @290 fee 5 gives 20 left, avg still 150,
  realised = (290x10 - 5) - 150x10 = 1,395.
- **FX both directions.** A native-SGD holding shown in USD = SGD / rate. A native-USD
  holding shown in SGD = USD x rate. Toggle SGD/USD: every figure scales by the rate, nothing
  double-converts.
- **CPF monthly split sums to the total contribution** and matches the age band. History
  total = monthly x months. If balances are unset, tab shows $0 with a history warning and
  the dashboard uses the history-computed figure.
- **Payday is the last working day** of the month: skip Sat/Sun and SG public holidays
  (Jan 2026 to 30th, Feb to 27th, May to 29th, a plain month like Mar needs no walk-back, all
  covered by `tests/test-core.js`).
- **Reconciliation clean.** `runReconciliation()` returns ok with a balanced dataset; it
  should flag unfunded trades, orphaned references, and negative balances when they exist.
- **Oversell tolerance is one constant.** `OVERSOLD_EPSILON` (kjr-core.js, 1e-6) is the only
  source of truth for both the trade-save warning and reconciliation. Grep for stray literal
  epsilons (`1e-9`, `5e-5`) if a fractional-oversell bug resurfaces, none should remain.
- **Dates round-trip through `kjrValidDate`.** Calendar-impossible dates (2026-02-30) are
  rejected on cloud load and in the entity modal, not just shape-regex checked.
- **Income tax (SG):** `computeSgIncomeTax` (kjr-core.js) at known points, chargeable 40k to
  550, 80k to 3,350, 120k to 7,950. Confirm it is annual on chargeable income (gross minus
  employee CPF minus reliefs), and the monthly figure is a provision (annual / 12), not a
  payslip deduction. Bonus month should show the marginal bump.

## Display invariants

- Empty states everywhere, no blank boxes.
- Colour never the only signal: pair with a label, sign, or icon.
- Overflow handled: long names/tables truncate or scroll, never burst the card.
- Both themes apply AND persist across reload. Charts recolour on theme switch.
- Dark is the default for fresh visitors (no flash of light theme), warm light is opt-in and
  survives reload once chosen.
- Hero net-worth card's second figure is labelled **"Ex-CPF"** (relabelled from "Liquid" on
  03/07/2026, it always included real estate so "Liquid" was misleading, maths unchanged).
- Mobile: absolute sort glyphs do not overlap clipped headers; cell font sizes consistent.
- At 430/390/375px: no horizontal scroll (`document.documentElement.scrollWidth === clientWidth`),
  Settings cog reachable, bottom bar shows 5 fixed tabs (Dashboard, Stocks, Cash, P&L, More)
  with the rest behind "More".

## Storage / data-safety invariants

- **Never persist `_priceCache` to localStorage.** It is transient and re-fetchable; it
  blew the ~5MB quota and blocked saving real data (v0.9.5 fix). It lives in memory only.
- **`saveLocal()` must degrade, not fail.** On QuotaExceededError it sheds disposable data
  (changelog, then old snapshots) and retries so financial entries are never the casualty.
- **One writer of truth per derived value.** If a value is derived from movements, EVERY
  consumer calls the same derive function. Never one view derives, another reads a raw field.
- Write-then-reload round-trip: edits persist to localStorage and survive a reload.
- Preview/localhost must never sync to the production Sheet. `isLocalPreview()` guards the
  top of `pushToRemote`, the beforeunload flush, and the seed push path (pulls stay allowed).
- **Saved charts and dashboard layout live in `DB.settings`** (`settings.savedCharts`,
  `settings.dashLayout`), not device-local storage, since D1. They ride sync, export and
  import for free. Verify: arrange dashboard + pin a chart, export backup, wipe, import, both
  survive.
- Payload chunking (A2): the backend splits large payloads across cells so sync does not die
  at ~50KB. `doGet` always reassembles into one JSON body, old clients keep working
  unchanged. If Julian sees a "Backend out of date, redeploy" toast, the Apps Script needs a
  fresh deploy at script.google.com (Deploy, Manage deployments, pencil, New version, Deploy).

## Release / cache-bust discipline

- Every deploy bumps together: `APP_VERSION` + `APP_DISPLAY_VERSION` (`Worker/app.js`),
  `CACHE_NAME` (`sw.js`, format `kjr-portfolio-v2.xx`), and the `?v=` query strings on every
  local `<script src>` in `index.html` AND the matching entries in `sw.js` CORE_ASSETS (they
  must match exactly, including the query string, or offline `caches.match` misses).
- `node tests/check-release.js` (wired into `npm test`) asserts all three agree and fails
  loudly on any mismatch. Run it before every ship, not just when you remember to.
- Stale `?v=` is a real, previously-shipped bug class: a script tag left on an old version
  number for several releases while the app version moved on, only saved by the manual
  CACHE_NAME bump. Do not rely on memory, let the check catch it.

## Constants ageing reminder (D6)

- CPF rates, SG tax brackets and SG public holidays are dated constants
  (`CONSTANTS_VERIFIED_FOR` in `kjr-core.js`, currently 2026). Every December, before the
  turn of the year: check CPF Board, IRAS and MOM for the coming year's rates/brackets/gazette,
  update `SG_HOLIDAYS`, `SG_TAX_BRACKETS`, `cpfContribRatesForAge`/`cpfAllocationForAge`, and
  bump `CONSTANTS_VERIFIED_FOR` in the same change.
- Settings > Diagnostics shows an amber warning automatically once the calendar year exceeds
  `CONSTANTS_VERIFIED_FOR`. Clean in 2026; to test the warning, temporarily override the
  clock/year in the console rather than waiting for January.

---

## Mistakes already made (do not repeat)

| Date | Mistake | Fix |
|------|---------|-----|
| 04/06 | `_cashSGD()` ignored cash movements + trade flows; dashboard understated net worth | route through `deriveCashBalance()` |
| 31/05 (v0.9.5) | persisted `_priceCache` to localStorage, hit quota, blocked all saves | drop it from the local payload; resilient `saveLocal` |
| 31/05 | app got buried in a double-nested `Kujira Portfolio/Kujira Portfolio/` folder, broke git + preview | keep runtime at repo root |
| 02/07 | `app.js?v=` left on an old version for several releases while `APP_VERSION` moved on, only the manual `CACHE_NAME` bump masked it | `tests/check-release.js`, wired into `npm test`, fails the build on any mismatch |
| 02/07 | doGet returned a malformed/corrupt payload on a partial write and the client treated it as "wrong schema", risking a seed-overwrite of real data | `seedDecision()` pure guard (kjr-core.js) refuses to seed over anything that `looksPopulated()`, regardless of schema mismatch |
| 03/07 (theme) | `theme-init.js` did nothing when no theme was stored, so a fresh visitor first-painted light then flipped to dark when `boot()` ran, a visible flash | `theme-init.js` adds the `dark` class unless the stored choice is exactly `'light'` |
| 03/07 (verification) | verifying a mid-session `Worker/*.js` edit in the preview browser without bumping `?v=` or clearing the service worker, sw.js serves the cache-first stale copy so the edit silently never loads | after any Worker JS edit during a verification session, unregister the service worker and clear caches in the console (or bump `?v=`), then confirm the new code is live via eval before judging |

For wider cross-project rules see `~/Claude Projects/Claude/lessons.md`.

---

## Feature-specific checks to add as they ship

- **Stocks column manager:** reorder + hide persists to settings; works on tap (mobile) not
  just drag; sticky symbol column; currency conversion still correct per visible column.
- **Stock analysis sub-tab:** delayed-data + not-advice disclaimer present; read-only (writes
  no trades); indicators match the MU Day Trading reference; market-closed state handled.
- **Chunked sync (A2):** manual round-trip on Julian's own sheet after any backend redeploy,
  confirm a JSON chunk starting with `=` or `+` does not get parsed as a Sheets formula (chunk
  cells are plain-text formatted).

---

This is a living document (a runbook, not a point-in-time spec). Update it in place whenever
QA process, ports, paths, or invariants change, do not create a v3 unless the whole approach
is being replaced.
