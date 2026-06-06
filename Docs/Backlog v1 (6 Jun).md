# Kujira Portfolio — Backlog

Candidate features, not started. Pick from here when ready. Full specs for the three
drafts live in `~/Claude Projects/Claude/tasks/todo.md` under "feature drafts". Each item
has rough priority and effort so picking is fast. Update status as things move.

Last updated: 06/06/2026. App at v0.9.8-interest-tax.

## Priority view

| # | Feature | Value | Effort | Status |
|---|---------|-------|--------|--------|
| 1 | Account interest accrual (cash APY) | High | Low | Done (v0.9.8) |
| 2 | Dividend income tracking | High | Medium | Backlog |
| 3 | SG income tax (Settings, salary + bonus) | High | Medium | Done (v0.9.8) |
| 4 | Stocks column manager (reorder/hide) | Medium | Medium | Drafted |
| 5 | Fix em dashes in prose copy (house style) | Low | Low | Backlog |
| 6 | IBKR CSV import | High | High | Backlog |
| 7 | Single-ticker analysis sub-tab (scalping) | Medium | High | Drafted |

## Items

### 1. Account interest accrual (cash APY)
Cash accounts have no yield field. Add an APY input per account and show projected
monthly/annual interest. Ties into the emergency-fund and net-worth-growth picture.
SG savers chase HYSA rates, so this is genuinely useful and small.

### 2. Dividend income tracking
Was in the original prototype. Real holdings (D05, etc.) pay dividends. Add a yield or
per-payment field per stock, project annual/monthly dividend income, surface yield-on-cost,
and feed it into P&L. Medium because it touches the stock model + P&L + dashboard.

### 3. SG income tax (Settings) — DRAFTED
Estimate annual SG resident tax from salary + bonus, show a monthly provision. Editable
bracket table + reliefs field, residency toggle. Finance nuance already captured in the
draft: annual on chargeable income, not monthly PAYE; monthly figure is an accrual.

### 4. Stocks column manager — DRAFTED
More columns (day range, 52w, volume, P/E, weight, etc.) plus user-controlled reorder and
hide, persisted to settings. Tap fallback for mobile (HTML5 drag is dead on touch).

### 5. Fix em dashes in prose copy
QA (4 Jun) found ~40 prose strings (hints, toasts, wizard) using em dashes, against the
house no-em-dash rule. The `'—'` empty-value token is fine and stays. Mechanical cleanup.

### 6. IBKR CSV import
Flagged very early as eventually needed. Parse an IBKR activity/trades CSV into the trade
ledger, removing the biggest manual-entry burden. High effort: CSV parsing, column mapping,
dedupe against existing trades, validation, preview-before-commit.

### 7. Single-ticker analysis sub-tab — DRAFTED
A sub-tab in Stocks to analyse one ticker (candles + VWAP/EMA/RSI/MACD) for scalping.
Overlaps the existing MU Day Trading app; draft proposes reusing that code, not duplicating.

## Notes
- Anything picked from here follows plan-first: confirm scope, snapshot, build, browser-verify, commit.
- New features must pass the relevant sections of `Docs/QA Runbook (4 Jun).md` before done.
- Still no cloud sync configured and nothing deployed live; both are separate open items.
