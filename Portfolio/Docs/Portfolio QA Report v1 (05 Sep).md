# Portfolio QA Report v1 (05 Sep)

Date: 05/09/2026

Version: v2.63 (05 Sep)

Build state: local, uncommitted, not pushed or deployed

## Scope and evidence

This is the final local QA receipt for Portfolio v2.63. It covers source remediation, automated checks, and a localhost browser pass with manual synthetic records only. The [Requirements baseline](Requirements%20v1%20%2805%20Sep%29.md) records the accepted insurance and CPF denominator rule.

No live Apps Script URL, credential, provider quote, production data, import injection or alternative upload path was used. Browser file upload was rejected by automatic review because permission was declined. A renewed asynchronous question remains unanswered, so browser quote-data import is not claimed.

## Verified checks

- Fresh `npm test` exited 0: core 108, app 90, vault 14, sortable 16 and values 13 assertions passed, with 13 v2.63 release checks
- `npm run test:browser` started the approved loopback server, printed its test-page URL, opened the actual `tests.html` in Harness and passed 30/30. The Browser result reported success, and the shell exited 0 with `[browser-tests] 30/30 passed`. `npm test` remains non-interactive
- The actual browser loaded v2.63 with matching Worker script queries and diagnostics badge
- At 375 x 812 and 1280 x 900 in dark and light themes, no horizontal page overflow remained after layout settled, and final console warnings and errors were empty
- More, Setup and Entity trapped Tab and Shift+Tab, Escape restored each opener at 375px, and Entity was repeated on desktop
- Setup URL has a real label and help text. Chart Builder search and holdings filter inputs expose their accessible labels
- Holdings sorting cycled none to ascending to descending to none through Enter, Space and Enter, once per key press. Focus stayed on the rebuilt button. Insurance also cycled ascending to descending
- On desktop, Setup still restored opener focus through open, close and reopen. Holdings sort focus had a computed 2px accent outline in dark `rgb(45, 212, 191)` and light `rgb(15, 110, 86)` themes
- Arrange mode disabled boundary moves, announced movement, retained logical focus, pointer-dragged a saved Net Worth chart below Allocation, cleared its placeholder, and persisted that order after reload
- The final scoped CSS fix makes the three saved chart control groups visible during Arrange mode. At both widths and themes, each group measured 90px high with 28 x 28px move buttons. Normal-mode clipping returned after Arrange mode ended

### Financial browser evidence

- Manual forms created QAX, 10 USD shares at US$100 with no quote, SGD cash S$1,000 with a long name and 2.5% APY, and USD cash US$800, both dated 01/09/2026
- A mismatched USD trade funded by SGD cash was blocked with no state change
- A USD100 to SGD transfer was blocked without an explicit received amount. A received amount of SGD125 produced SGD cash S$1,125, USD cash US$700 and S$2.34 monthly interest
- With FX absent, the known total was S$1,125, excluding two assets. Projections were unavailable and no canvas rendered. At USD/SGD 1.25, cash was S$2,000 and the stock value was S$1,250
- An active QA Endowment policy with S$2,000 cash value and CPF OA opening balance S$1,000 produced Dashboard ex-CPF S$5,250 and with-CPF S$6,250
- With CPF on, weights were Stocks 20%, Cash 32%, CPF 16% and Insurance 32%. With CPF off, Stocks 24%, Cash 38% and Insurance 38%. Each visible set rounded to 100%
- Allocation chart summaries changed from S$5,250 across three groups to S$6,250 across four groups. Projections started with liquid S$3,250 and CPF S$1,000
- The canonical [Seed fixture](../tests/fixtures/QA%20Seed%20v1%20%2805%20Sep%29.json) and [Prices fixture](../tests/fixtures/QA%20Prices%20v1%20%2805%20Sep%29.json) supplied the source JSON price oracle and S$600 delta that passed [value tests](../tests/test-values.js). Browser quote-data import was not exercised

## Resolved findings

### P1-01 High, Chart Builder percentage units, fixed

`PB_HOLDINGS_FIELDS` now returns percentage values once, and chart aggregation formats the existing unit contract without a second scale. The price oracle covers the percentage and S$600 change paths. Sources: [app](../Worker/app.js), [core](../Worker/kjr-core.js), [value tests](../tests/test-values.js).

### P1-02 High, missing FX no longer becomes a 1:1 SGD total, fixed

`sgdOrNull`, valuation information and projection guards exclude unconvertible assets, report the known subtotal and suppress an unsafe projection canvas. The manual missing-rate and USD/SGD 1.25 browser cases passed. Source: [app](../Worker/app.js).

### P1-03 High, pull waits for local and cloud writes, fixed

`_quiesceSavesBeforePull` waits for local persistence, queued work and the active push before `pullFromRemote` applies remote state. Revision checks retry after a local edit during GET. Delayed push and pull cases passed in [app tests](../tests/test-app.js).

### P1-04 High, backup envelope metadata cannot poison canonical sync, fixed

`_stripBackupMetadata` and `localPersistPayload` remove backup-only metadata before local and cloud persistence. Export, import and sync regression coverage passed. Source: [app](../Worker/app.js).

### P1-05 High, failed persistence cannot claim success, fixed

`saveData` tracks a local-unsaved state, awaits encrypted writes and returns failure to mutation handlers. The tests cover failed local and vault persistence without a success acknowledgement. Sources: [app](../Worker/app.js), [app tests](../tests/test-app.js).

### P2-01 Medium, cross-currency cash legs are explicit, fixed

`linkedTradeCurrencyMismatch` blocks a linked trade in a different account currency. `crossCurrencyTransferMissingAmount` requires the received amount for a cross-currency transfer. The manual blocked and valid transfer cases passed. Source: [app](../Worker/app.js).

### P2-02 Medium, restore validates and renders inertly, fixed

`normaliseEntityRow`, `_sanitiseList` and `restoreFromTrash` use the entity schema and safe own-data copies. Valid and malicious restore cases passed in Node. Browser deletion and restore are not claimed because the native confirm test timed out before deletion. Source: [app](../Worker/app.js).

### P2-03 Medium, Dashboard and Allocation share the insurance and CPF rule, fixed

`_allocationData` includes active insurance and excludes CPF before calculating the visible denominator when CPF is off. Dashboard and chart summaries passed the manual insurance and CPF cases. Source: [app](../Worker/app.js).

### P2-04 Medium, dialog focus and input labels, fixed

`openModalFocus` and `closeModalFocus` provide visible-enabled focus selection, Tab wrapping, cleanup and opener restoration for More, Setup and Entity. The setup URL and Chart Builder inputs now expose names and help. Sources: [app](../Worker/app.js), [index](../index.html).

### P2-05 Medium, Dashboard Arrange has keyboard controls, fixed

`moveDashWidget` and `_dashDecorate` provide named Move buttons, disabled boundaries, live announcements and focus continuity while the existing KjrSortable handle keeps pointer drag. The Arrange browser flow passed. Sources: [app](../Worker/app.js), [index](../index.html), [sortable test page](../tests/tests.html).

## Lower-priority resolutions

- Sortable headers now use native buttons. `aria-sort` remains on each table header, and rebuilt-button focus returns after keyboard sorting
- Local script and service-worker asset queries align at v2.63, confirmed by the 13 release checks. Sources: [index](../index.html), [service worker](../sw.js)
- The local-persistence payload comment now describes the separately stored price cache correctly. Source: [app](../Worker/app.js)
- `npm run test:browser` passed its interactive [browser runner](../tests/test-browser.js) against the actual test page, 30/30

## Remaining gates

- Browser quote-data import remains unexercised after the declined file-upload permission. No replacement import route was used
- Live Apps Script sync, real provider quotes, vault credential UI, high-volume stress, installed PWA update and deployed GitHub Pages remain unverified
- Browser delete and restore remain unverified. Node validation and malicious-restore coverage passed

## Verdict

All ten numbered source findings are fixed in local v2.63 and the stated manual browser and automated evidence passed. This is not a shipment claim. No commit, push or deployment has occurred, and the remaining gates above stay open.

Attribution: Values and Access, gpt-5.6-terra. Guard, gpt-5.6-sol. Testporter, gpt-5.6-luna. Root Codex reviewed the changes and performed the final browser validation.

*Disposable point-in-time doc. Delete once fully actioned (see AGENTS.md, Folder cleanliness).*
