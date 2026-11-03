# Portfolio Browser QA

Cross-browser smoke pass of the Portfolio app at v2.88. Run on 03/11/2026 with Playwright 1.64.0 on Linux.

## Bottom line

- Chromium baseline is clean. 237 of 237 checks passed, with zero console errors on every page, theme and width.
- WebKit and Firefox did not run in this session. The cloud environment's network policy blocks Playwright's browser downloads (`cdn.playwright.dev` and its mirrors). No WebKit or Firefox result in this doc is a measured result.
- Two engine defects are predicted from the code and need a Mac run to confirm. Both are low severity.
- The pass is scripted. Run `Portfolio/tests/cross-browser.mjs` on the Mac to get the real WebKit and Firefox results (command at the end).

## Findings

Status key: Confirmed means seen in a browser. Predicted means read from the code and not yet seen in a browser.

| ID | Engine | Page | Steps to reproduce | Expected | Actual | Severity | Status |
|---|---|---|---|---|---|---|---|
| F1 | WebKit and Firefox on macOS (Safari, Firefox) | Any dialog opened with a mouse click: Add stock, sync details, holding panel, More sheet | 1. Open Stocks. 2. Click + Add stock with the mouse. 3. Press Escape. 4. Press Tab. | Focus goes back to the + Add stock button, so Tab carries on from there | Focus lands on the page body, so Tab may restart at the top of the page. `openModalFocus` (`Worker/app.js:7000`) stores `document.activeElement` as the opener, and Safari and Firefox on macOS do not focus a button on a mouse click. Keyboard opening is not affected | Low | Predicted. Chromium passes. Linux WebKit and Linux Firefox focus buttons on click, so only a Mac run shows it. The script's `focus returns to the opener` check for the mouse dialogs will fail if it is real |
| F2 | WebKit, Safari 17 and earlier (iOS 17 and earlier) | Any modal: Add stock, sync details, column managers | 1. Open any modal on iOS 17. 2. Look at the page behind it. | The dimmed page behind the modal is blurred, as in Chromium | No blur behind the modal, only the flat dim layer. `.overlay` sets `backdrop-filter:blur(4px)` with no `-webkit-` twin (`index.html:420`). Safari only reads the unprefixed property from 18. The modal card itself is fine, it carries both | Low (cosmetic) | Predicted. Not visible in current Safari 18 or later |
| F3 | Firefox before 121 (ESR 115) | Pages whose head holds only a title | Open any such page in Firefox ESR 115 | The page head drops its bottom margin | The extra margin stays. The rules at `index.html:309` and `index.html:915` use `:has()`, which Firefox only supports from 121, so the whole rule is skipped | Info | Predicted. Current Firefox supports `:has()` |
| F4 | WebKit, Safari before 18.2 | Sidebar nav on desktop | Scroll the sidebar nav in Safari 17 | Thin scrollbar | Full-width scrollbar. `scrollbar-width:thin` (`index.html:159`) is ignored before Safari 18.2 | Info | Predicted |

No engine-specific defect was confirmed in this session. No screenshots are committed, because nothing was confirmed. The Chromium screenshots (50 files, 3.6 MB) stay out of the repo.

## How the app renders with no backend

- With no sync URL stored, the app boots in local-only mode. The sidebar status reads Local only and nothing calls Apps Script.
- The QA seed loads through localStorage. The script writes the seed (minus `_priceCache`) to `kjr-pf-db-v1`, the seed's `_priceCache` to `kjr-pf-price-cache-v1`, and sets `kjr-pf-wizard-dismissed-v1`. This happens once per context before any app script runs.
- The seed has no schema version, so the app runs its migrations on load. Migration 2 clears `tabCurrency`, so Stocks and Watchlist show USD (the app default). This is expected, not a defect.
- Every page renders meaningfully. The dashboard headline reads S$110,500, the seed's net worth excluding CPF (S$120,500 with CPF, matching `test-values.js`).
- Chart.js comes from `cdn.jsdelivr.net`, which the guard blocks. `window.Chart` is undefined, so no chart draws. The app degrades cleanly: no page errors and no console errors beyond the blocked load. The npm copy of Chart.js 4.4.1 is the unminified build, so its hash does not match the pinned SRI and it cannot stand in offline.
- The Manrope web font is blocked too, so text falls back to the system font stack.

## Chromium baseline (Chromium 153, measured)

| Area | What was checked | Result |
|---|---|---|
| Boot | Dashboard is the first page, version badge v2.88 | 1 of 1 |
| Tabs | All 12 pages, dark and light, 1280 px and 390 px. Page active and filled, theme class right, no unexpected console errors, no sideways page scroll | 192 of 192 |
| Sorting | Stocks holdings, Symbol header. aria-sort goes none, ascending, descending and the rows reverse | 1 of 1 |
| Dialogs | + Add menu (keyboard), Add stock modal (keyboard and mouse), sync details, holding panel, command palette (Ctrl+K), More sheet at 390 px. Opens, focus moves inside, Escape closes, focus returns to the opener, no console errors | 33 of 33 |
| Forms | Add stock. A blank save shows "Required: Symbol". A bad symbol shows the symbol rule. The modal stays open. Nothing is written | 4 of 4 |
| CSS | Top bar and sidebar stay pinned after an 800 px scroll | 1 of 1 |
| Service worker | Registers and activates, page controlled after reload, cache `kjr-portfolio-v2.88` holds 12 entries, offline reload shows the dashboard with the same figures and no console errors | 5 of 5 |

## Values to compare on the Mac

The script compares these with Chromium and lists every difference. Chromium gave:

- Intl, en-SG: SGD `$1,234,567.89`, USD `US$1,234,567.89`, HKD `HK$1,234,567.89`, compact `1.2M`, percent `12.3%`
- Intl dates, Asia/Singapore: medium `5 Mar 2026`, long `5 March 2026 at 10:07 pm`, en-GB weekday `Thursday 5 March`
- App helpers: `fmt` gives `S$1,234,567.89` and `-US$9,876.50`, signed `+S$42.00`, `fmtCompact` `S$3.21T`, `fmtDateSG` `31/03/2026`, `fmtPct` `▼ -1.23%`
- CSS support: `:has()`, unprefixed `backdrop-filter`, `color-mix()`, subgrid, `100dvh`, `scrollbar-width`, `:focus-visible` and `inert` all supported. `-webkit-backdrop-filter` not supported (expected in Chromium). The app uses no scroll snapping and no `<dialog>` element. Its dialogs are `div[role=dialog]` overlays with a script focus trap

## Blocked outbound URLs

Every request outside localhost was refused. Nothing reached a live service.

From the app (context route):

- `https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&display=swap`
- `https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js` (page load and the service worker install)

From Chromium itself, not the app (black-hole proxy):

- `https://accounts.google.com:443`
- `https://update.googleapis.com:443`
- `https://www.google.com:443`
- `https://content-autofill.googleapis.com:443`
- `https://android.clients.google.com:443`
- `https://redirector.gvt1.com:443`

No request went to Apps Script, Yahoo, the Trading Worker, the NAS or Supabase. Storage held no sync URL and no `nas` backend mode at the end of the run.

## Not tested

- WebKit and Firefox, all checks. The network policy blocks `cdn.playwright.dev`, `playwright.download.prss.microsoft.com`, `download.mozilla.org` and `packages.mozilla.org`. Ubuntu's `firefox` package is a snap stub, and Playwright cannot drive a stock WebKit
- Charts of every kind (hero chart, Explore, holding panel 3-month chart), because Chart.js is blocked
- Live prices, sync, backup and restore, all of which need Apps Script
- Even on the Mac, Playwright WebKit is not Safari. It lacks Safari's own features (autofill, Keychain, content blockers, Intelligent Tracking Prevention storage limits) and the iOS layout engine quirks. Use a real iPhone for the bottom bar, safe areas and the PWA install
- Screen readers (VoiceOver, NVDA). The focus checks cover keyboard focus only
- Touch input. The 390 px pass uses a narrow desktop viewport, not touch events

## Outside scope, seen while running the suites

- `npm test` from `Portfolio/` fails on Linux at `tests/check-nas-config.js` (29 checks). It fails the same way with this change removed. One cause: `mode_is_600` in `NAS/backup.sh:119` and `NAS/restore.sh:133` tries BSD `stat -f '%Lp'` first. GNU `stat` reads that as filesystem mode, prints a block of output and exits 1. The output is still captured, so the `stat -c '%a'` fallback's `600` never stands alone and the check fails. On a NAS with GNU coreutils, backup and restore would always stop with "env file must have mode 600". The other 13 scripts in the chain pass.

## Rerun

From the repo root on the Mac:

```bash
npm i -g playwright@1.64.0
```

```bash
npx -y playwright@1.64.0 install --with-deps chromium webkit firefox
```

```bash
npx serve -l 3807 .
```

In a second terminal:

```bash
node Portfolio/tests/cross-browser.mjs --out="$TMPDIR/kjr-browser-qa"
```

The script exits 0 when every engine passes, 1 on a failed check or an engine that will not launch, 2 on a safety violation. The report lands in `report.json` in the output folder, with a `diffs` list against Chromium.

*Disposable point-in-time doc. Delete once fully actioned (see CLAUDE.md, Files and hygiene).*
