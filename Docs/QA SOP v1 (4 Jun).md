# Kujira Portfolio — QA Runbook

How to QA this app after any change, and the mistakes that must never come back.
Re-run the whole thing whenever a new feature touches money, display, or storage.

Last updated: 04/06/2026 (app v0.9.6).

---

## How to run a QA pass

1. **Start the preview.** Server name `investments` in the global launch config, serves
   the repo root on port 3801. App is at `/index.html`.
2. **Static scan first** (cheap, catches dead buttons):
   - No duplicate top-level function defs: `grep -oE "^function [a-zA-Z0-9_]+" index.html | sort | uniq -d` (expect blank).
   - Every inline `onclick`/`oninput`/`onchange` handler resolves to a defined function. (`document.*` calls are false positives, ignore.)
3. **Seed a representative dataset** in the browser console (preview_eval), do NOT type into prod:
   - 2+ stocks including one SGX (native SGD) and one US (USD), plus at least one **sell** trade linked to a brokerage cash account.
   - 2 cash accounts, one of them a USD brokerage that the sell credits.
   - salary + bonus + birth year (drives CPF + tax), targets, EF target, salary rules, one property.
   - set an FX override (e.g. 1.35) so currency maths is checkable by hand.
4. **Assert numbers, do not eyeball.** Pull computed values via eval and check them against
   hand maths (see invariants below). Screenshots are for layout, not for accuracy.
5. **Walk every tab**: Dashboard, Stocks, Cash, CPF, P&L, Real Estate, Settings. Check
   golden path + empty state + both themes (light default, dark) + both currencies (SGD/USD).
6. **Check the console on every tab.** Zero errors is the bar.
7. **Reset to a clean first-run state** when done (wipe seed, clear theme + wizard-dismissed
   keys) so the user does not inherit test data.

---

## Money invariants (must always hold)

These are the checks that catch finance bugs. Add a new one whenever a feature adds a number.

- **Dashboard cash == Cash tab total.** Both must use `deriveCashBalance()` (opening +
  movements + linked trade flows). The 04/06 bug was `_cashSGD()` reading the raw `amount`
  field, understating net worth by any brokerage trade proceeds.
- **Net worth == sum of the asset-class cards.** Stocks + Cash + CPF + Real Estate + Crypto.
- **Stocks: market value − total cost == unrealised P&L.** Realised P&L comes only from sells.
- **Partial sell maths.** Open 30 @150, sell 10 @290 fee 5 → 20 left, avg still 150,
  realised = (290×10 − 5) − 150×10 = 1,395.
- **FX both directions.** A native-SGD holding shown in USD = SGD ÷ rate. A native-USD
  holding shown in SGD = USD × rate. Toggle SGD/USD: every figure scales by the rate, nothing double-converts.
- **CPF monthly split sums to the total contribution** and matches the age band. History
  total = monthly × months. If balances are unset, tab shows $0 with a history warning and
  the dashboard uses the history-computed figure.
- **Payday is the last working day** of the month: skip Sat/Sun and SG public holidays.
  (Jan 2026 → 30th, Feb → 27th, May → 29th.)
- **Reconciliation clean.** `runReconciliation()` returns ok with a balanced dataset; it
  should flag unfunded trades, orphaned references, and negative balances when they exist.

## Display invariants

- Empty states everywhere, no blank boxes.
- Colour never the only signal: pair with a label, sign, or icon.
- Overflow handled: long names/tables truncate or scroll, never burst the card.
- Both themes apply AND persist across reload. Charts recolour on theme switch.
- Mobile: absolute sort glyphs do not overlap clipped headers; cell font sizes consistent.

## Storage / data-safety invariants

- **Never persist `_priceCache` to localStorage.** It is transient and re-fetchable; it
  blew the ~5MB quota and blocked saving real data (v0.9.5 fix). It lives in memory only.
- **`saveLocal()` must degrade, not fail.** On QuotaExceededError it sheds disposable data
  (changelog, then old snapshots) and retries so financial entries are never the casualty.
- **One writer of truth per derived value.** If a value is derived from movements, EVERY
  consumer calls the same derive function. Never one view derives, another reads a raw field.
- Write-then-reload round-trip: edits persist to localStorage and survive a reload.
- Preview/localhost must never sync to the production Sheet.

---

## Mistakes already made (do not repeat)

| Date | Mistake | Fix |
|------|---------|-----|
| 04/06 | `_cashSGD()` ignored cash movements + trade flows; dashboard understated net worth | route through `deriveCashBalance()` |
| 31/05 (v0.9.5) | persisted `_priceCache` to localStorage, hit quota, blocked all saves | drop it from the local payload; resilient `saveLocal` |
| 31/05 | app got buried in a double-nested `Kujira Portfolio/Kujira Portfolio/` folder, broke git + preview | keep runtime at repo root |

For wider cross-project rules see `~/Claude Projects/Claude/lessons.md`.

---

## Feature-specific checks to add as they ship

- **Income tax (SG):** assert `computeSgIncomeTax` at known points (chargeable 40k → 550,
  80k → 3,350, 120k → 7,950). Confirm it is annual on chargeable income (gross − employee
  CPF − reliefs), and the monthly figure is a provision (annual ÷ 12), not a payslip deduction.
  Bonus month should show the marginal bump.
- **Stocks column manager:** reorder + hide persists to settings; works on tap (mobile) not
  just drag; sticky symbol column; currency conversion still correct per visible column.
- **Stock analysis sub-tab:** delayed-data + not-advice disclaimer present; read-only (writes
  no trades); indicators match the MU Day Trading reference; market-closed state handled.
