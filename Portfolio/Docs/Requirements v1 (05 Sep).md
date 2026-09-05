# Portfolio QA Requirements Baseline

**Prepared:** 05/09/2026

**Status:** Source-derived QA baseline, not a new product specification

**Scope:** Local Portfolio QA with synthetic records only

**Reviewed:** 05/09/2026 against local v2.63, with automated and browser-runner evidence complete. Browser quote-data import remains unexercised

There is no Portfolio PRD in this repository. This baseline records existing behaviour from the app, the QA SOP and the Apps Script source. It separates binding data-safety invariants from source-inferred expectations and unresolved requirements.

## Evidence classes

- **EXPLICIT** is a documented QA SOP or data-safety invariant
- **INFERRED** is current source or UI behaviour that requires browser confirmation
- **UNKNOWN** has no governing requirement in this checkout

## Synthetic QA setup

Use [QA Seed v1 (05 Sep).json](../tests/fixtures/QA%20Seed%20v1%20%2805%20Sep%29.json) and [QA Prices v1 (05 Sep).json](../tests/fixtures/QA%20Prices%20v1%20%2805%20Sep%29.json) as the canonical controlled source price oracle. Both fixtures use only synthetic records, no URLs or credentials, and `USDSGD: 1.25`. The second file differs only in four cached quote values. The v2.63 value suite loaded the canonical fixtures and passed all 13 assertions, including the S$600 delta.

When browser file permission is available, import the Seed fixture in an isolated localhost profile, then import Prices. Import replaces the active browser dataset. The app must request confirmation and create its automatic pre-import recovery snapshot before replacement. Do not paste a production sync URL into the test session. Browser quote-data import remains unexercised because file-upload permission was declined.

The fixtures intentionally have no transactions, salary, CPF history or snapshots. This keeps the price oracle stable. It means realised trade P&L, salary accrual, historical net-worth charts and high-volume pagination remain separate tests.

`_priceCache` is present only to test local displayed prices. Current code excludes it from the canonical `LK_DB` and cloud sync payload, then stores last-known prices separately under `LK_PRICE_CACHE`. It must never enter an exported canonical backup or a remote payload.

## Explicit data-safety invariants

| ID | Requirement | Evidence |
|---|---|---|
| DS-01 | A localhost or `file:` preview must never push synthetic data to a cloud Sheet, including the unload path | QA SOP and `isLocalPreview()` guards |
| DS-02 | An import must confirm replacement and attempt a recoverable pre-import snapshot before modifying the active browser dataset | `importBackupFromFile()` |
| DS-03 | `_priceCache` must remain outside canonical local and cloud payloads, while a separately stored last-known cache may restore after reload | QA SOP and `localPersistPayload()` |
| DS-04 | Local concurrent edits must merge by record ID, with an unreconciled earlier value stashed for recovery rather than silently lost | local merge functions |
| DS-05 | Cloud writes must use the server timestamp as the optimistic-concurrency token. The backend must lock the read, compare and write sequence | `pushToRemote()` and `apps-script.gs` |
| DS-06 | A non-empty remote with an unknown schema must not be auto-seeded or overwritten | `seedDecision()` |

## Source-inferred acceptance requirements

| ID | Requirement and done-when condition | Evidence class |
|---|---|---|
| QA-NAV-01 | Dashboard, Stocks, Watchlist+, Crypto, Real Estate, Insurance, Cash, CPF, P&L, Projections and Settings open from the live navigation. Each has a populated and an empty-state check | INFERRED |
| QA-FORM-02 | Create and edit forms reject required-field omissions, negative values where the schema forbids them, invalid IDs and calendar-impossible dates. A valid saved row re-renders with the entered values | INFERRED and EXPLICIT date invariant |
| QA-PRICE-03 | Importing each fixture updates every quote-dependent holding, stock summary, crypto summary, dashboard class, current net worth, allocation surface and current holdings chart according to the oracle below. Shares, cost basis, annual dividend, yield-on-cost, cash, CPF, property and insurance stay unchanged | INFERRED |
| QA-FX-04 | Stocks and Watchlist+ convert USD and SGD consistently at 1.25 when their display toggle changes. Dashboard, Cash, CPF, P&L, Real Estate, Insurance, Crypto, Projections and Settings remain SGD surfaces | INFERRED |
| QA-PERSIST-05 | A saved create or edit survives reload with vault off and on. Synthetic quotes can restore only from the separate local price cache, never from the canonical exported or synced DB | EXPLICIT and INFERRED |
| QA-IMPORT-06 | A valid JSON import restores recognised records. Invalid JSON and an object with no recognised portfolio key are rejected. Exported data can be re-imported without losing canonical records | INFERRED |
| QA-SYNC-07 | A dedicated disposable Sheet test proves initial seed protection, pull, push, a server-stamp conflict, recovery or strict-conflict handling, and no preview write. It must never use Julian's live Sheet | EXPLICIT and INFERRED |
| QA-PWA-08 | The installed PWA serves the cached shell offline, refreshes HTML network-first when online, and reports an explicit offline asset failure when an uncached asset is unavailable. Release checks keep script URLs, cache name and app version aligned | INFERRED and EXPLICIT release check |
| QA-VISUAL-09 | Dark is the fresh default and light persists. At 430px, 390px and 375px there is no horizontal page overflow, the settings control remains reachable and the five fixed mobile tabs remain usable. Long names, no-data states and non-colour status cues remain legible | EXPLICIT QA SOP |
| QA-A11Y-10 | Keyboard navigation reaches actions and dialogs, visible focus remains available, labels explain status beyond colour and tables remain usable with long text | INFERRED |
| QA-INT-11 | `runReconciliation()` is clean for the fixture. A separate controlled test must detect an unfunded trade, an orphaned reference, an oversold position and a negative cash balance | EXPLICIT QA SOP |

## Price-change oracle

The quote timestamp is a fixed synthetic scenario timestamp, `2026-09-05T23:59:59.000Z`. Calculations below are independent arithmetic from shares, cost, dividend, cached quote and the fixed 1.25 FX rate. Browser quote-data import execution has not yet been claimed.

| Scenario | Holding | Shares | Cost basis | Quoted price | Market value | Unrealised P&L | Annual dividend | Yield on cost | Current yield | Stock weight |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Seed | QAAA, USD | 10 | US$800.00, S$1,000.00 | US$100.00 | US$1,000.00, S$1,250.00 | +US$200.00, +S$250.00 | US$40.00, S$50.00 | 5.0000% | 4.0000% | 55.5556% |
| Seed | QBBB, SGD | 100 | S$800.00 | S$10.00 | S$1,000.00 | +S$200.00 | S$40.00 | 5.0000% | 4.0000% | 44.4444% |
| Prices | QAAA, USD | 10 | US$800.00, S$1,000.00 | US$120.00 | US$1,200.00, S$1,500.00 | +US$400.00, +S$500.00 | US$40.00, S$50.00 | 5.0000% | 3.3333% | 57.6923% |
| Prices | QBBB, SGD | 100 | S$800.00 | S$11.00 | S$1,100.00 | +S$300.00 | S$40.00 | 5.0000% | 3.6364% | 42.3077% |

| Asset class or metric | Seed | Prices | Change |
|---|---:|---:|---:|
| Stocks, market value | S$2,250.00 | S$2,600.00 | +S$350.00 |
| Stocks, total cost | S$1,800.00 | S$1,800.00 | S$0.00 |
| Stocks, unrealised P&L | +S$450.00 | +S$800.00 | +S$350.00 |
| Stocks, annual dividend | S$90.00 | S$90.00 | S$0.00 |
| Crypto, market value | S$1,250.00 | S$1,500.00 | +S$250.00 |
| Crypto, cost and P&L | S$1,000.00 and +S$250.00 | S$1,000.00 and +S$500.00 | P&L +S$250.00 |
| Cash | S$5,000.00 | S$5,000.00 | S$0.00 |
| CPF | S$10,000.00 | S$10,000.00 | S$0.00 |
| Real Estate | S$100,000.00 | S$100,000.00 | S$0.00 |
| Active insurance cash value | S$2,000.00 | S$2,000.00 | S$0.00 |
| Current net worth, with CPF | S$120,500.00 | S$121,100.00 | +S$600.00 |
| Dashboard default net worth, ex-CPF | S$110,500.00 | S$111,100.00 | +S$600.00 |

The accepted accounting rule includes active insurance cash value in net worth, Dashboard and allocation. Dashboard starts with CPF off, so the visible hero is ex-CPF while insurance remains included. Turning CPF on changes the hero to the full net-worth values above.

The allocation denominator is calculated after applying the CPF setting. With CPF on, it includes CPF and active insurance. With CPF off, it excludes CPF before calculating total and weights, while retaining insurance. The included visible classes must round to 100%. Dashboard and Allocation use the same accepted insurance and CPF rule.

## Accepted decisions and remaining unknowns

| ID | Unknown or inconsistency | Required treatment |
|---|---|---|
| U-01 | There is no Portfolio PRD or approved product requirements document | Do not treat this baseline as approval for new behaviour |
| U-02 | Active insurance cash value is included in current net worth, Dashboard and allocation | Accepted in v2.63. Manual browser QA confirmed the rule with a S$2,000 active policy |
| U-03 | The allocation denominator is calculated after the CPF setting is applied. With CPF off, CPF is excluded before weights are calculated. Active insurance remains included | Accepted in v2.63. Manual browser QA confirmed 100% rounded visible weights with CPF both on and off |
| U-04 | No dedicated disposable Apps Script endpoint or scripted two-client CAS fixture is supplied | Leave remote sync and conflict evidence unverified until one exists |
| U-05 | The supplied price fixture is deliberately small and does not establish pagination, extreme-length or many-record performance | Use a separately generated local-only stress dataset for that acceptance criterion |

*Disposable point-in-time doc. Delete once fully actioned (see AGENTS.md, Folder cleanliness).*
