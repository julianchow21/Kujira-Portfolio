# Kujira Portfolio — QA Report

Date: 04/06/2026
App version: 0.9.6-cash-derive-fix
Method: static scan + live Claude Preview with a seeded dataset, numbers asserted not eyeballed.

## Verdict

Pass. 40+ assertions across money logic, flows, display, storage and integrity all
passed. No new bugs found in code. Zero console errors/warnings on any of the 9 tabs.
One pre-existing style nit logged (em dashes in prose copy). Enhancement list at the end.

## What was tested and the result

### Static
- No duplicate top-level function definitions.
- Every inline `onclick`/`oninput`/`onchange` handler resolves to a defined function (only false positive: `document.*`).
- `<script>` tags balanced (2/2). Single Chart.js include, SRI-pinned.

### Money invariants (all PASS)
- Partial sell: open 30 @150, sell 10 @290 fee 5 → 20 left, avg 150, realised P&L 1,395.
- CPF age 36: employee 1,600, employer 1,360, total 2,960, net 6,400, OA+SA+MA split sums to total.
- CPF OW ceiling: gross 12,000 caps contribution at the 8,000 wage, but net reflects full gross.
- CPF age bands differ (40 vs 60 give different totals).
- Asset classes SGD: stocks 17,391.23, cash 52,658.25, CPF 14,800, real estate 650,000.
- Net worth = sum of classes (734,849.48 with seed). 
- Dashboard cash == Cash tab total (the 04/06 derived-balance fix holds).
- Payday last-working-day: Jan→30, Feb→27, Apr→30, May→29, Dec→31 (weekends/holidays skipped).

### Currency + theme
- Per-tab override persists; Stocks defaults USD, others SGD.
- `fmt()` converts both directions at 1.35 with no double-conversion.
- Net worth in USD = SGD ÷ rate.
- Light/dark toggle applies (bg #faf9f6 ↔ #0f0f0f) and persists across reload.
- (One test line flagged FALSE initially: reading `displayCcy()` after `renderAll` cycled tabs. Confirmed a test-harness artifact, not an app bug; the toggle writes the override correctly.)

### Flows (all PASS)
- Edit real estate via modal → persists to localStorage.
- Add cash account via modal → list grows.
- Delete → routes to trash (soft delete), account removed from live list.
- Over-sell guard: `sharesHeldAsOf` returns the correct remaining holding.

### Data integrity (all PASS)
- `runReconciliation()` clean on a good dataset.
- Catches: orphaned trade (deleted stock/cash ref), negative balance, unfunded trade.
- Restores to clean after corruption removed.

### Storage resilience (all PASS, the 31/05 fix)
- `_priceCache` is NOT persisted to localStorage (50-symbol cache stayed in memory, blob stayed tiny).
- Financial tables (stocks, cash) ARE persisted.
- `saveLocal()` returns true on success; `mergeDefaults` re-inits price cache on load.

### Display
- All 9 tabs render, page becomes active, no console errors.
- Empty state (zero data): "$0.00", "No holdings yet" with guidance, charts show "no history yet"/"no data", no blank boxes.
- Mobile 390px: KPI cards reflow 2-up, bottom tab bar appears, nothing overflows.

## Issues found

| Sev | Issue | Status |
|-----|-------|--------|
| Low | Em dashes in ~40 prose strings (hints, toasts, wizard) break the house no-em-dash style. The `'—'` empty-value token is fine and stays. | Logged, fix folded into next edit pass |

No medium or high severity issues. (The cash-derive bug from the prior QA was already fixed in v0.9.6.)

## Reset

App reset to a clean first-run state after testing: empty DB, light theme, wizard not
dismissed, no test data left in localStorage.
