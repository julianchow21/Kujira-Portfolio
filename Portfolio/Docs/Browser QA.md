# Portfolio Browser QA

Cross-browser smoke pass of the Portfolio app at v2.88, in two runs on 03/11/2026, both with Playwright 1.64.0.

- Linux run (cloud session): Chromium 153 only, because the network policy blocked the WebKit and Firefox downloads
- Mac run (macOS 27.0.1, Apple silicon): Chromium 156.0.8078.4, WebKit 27.2 and Firefox 157.0 (build 1555)

## v2.89 update (03/11/2026)

- F1 is fixed in v2.89. Every dialog now gets its opener from the caller, so a Safari mouse click returns focus to the button. It still needs a WebKit rerun on the Mac to confirm.
- F2 is fixed in v2.89. `.overlay` now carries `-webkit-backdrop-filter:blur(4px)` beside the unprefixed rule. It is the only unprefixed `backdrop-filter` in the app. Only Safari 17 or an iOS 17 device can show the blur.
- The three harness misses are fixed. See Harness notes.
- `cross-browser.mjs` has a new Safari-style click check. It blurs focus, dispatches the click without focusing the opener, presses Escape and asserts focus is back on the opener. It covers Add stock, + Add menu then Stock, sync details, the holding panel, the palette button, stock Columns, the setup wizard and the More sheet at 390 px.
- Linux run, Chromium 153 only. The network policy blocked the WebKit and Firefox downloads again (HTTP 403 from the proxy for `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`).
- On v2.88 the Safari-style check failed six times in Chromium, focus landed on the body. The holding panel and the + Add menu passed, as in WebKit. On v2.89 Chromium passes 283 of 283.

## Bottom line (v2.88 run)

- Chromium is clean on both runs. 237 of 237 checks passed on Linux and on the Mac, with zero unexpected console errors.
- WebKit 27.2 passed 230 of 237. Three failures are F1, now confirmed. The other four are the network guard's blocked CDN loads, which WebKit words in a way the script's filter misses. They are not app defects (see F5 and Harness notes).
- Firefox did not run. Playwright's Firefox 157 build quits at startup on this Mac with "Could not find profile folder." No Firefox result in this doc is measured.
- F1 is confirmed in WebKit. F2 is neither confirmed nor cleared. Current WebKit applies the blur, and no engine on this Mac behaves like Safari 17.
- In WebKit, every app value the script compares matched Chromium: the money and date helpers, the form validation messages and the dashboard headline. The eight differences it lists come from engine wording, a script reading quirk and a theme mismatch in the script.

## Findings

Status key: Confirmed means seen in a browser. Predicted means read from the code and not yet seen in a browser.

| ID | Engine | Page | Steps to reproduce | Expected | Actual | Severity | Status |
|---|---|---|---|---|---|---|---|
| F1 | WebKit on macOS (Safari). Firefox on macOS predicted | Dialogs opened with a mouse click: Add stock, sync details, More sheet | 1. Open Stocks. 2. Click + Add stock with the mouse. 3. Press Escape. 4. Press Tab. | Focus goes back to the + Add stock button, so Tab carries on from there | Focus lands on the page body. `openModalFocus` (`Worker/app.js:7000`) stores `document.activeElement` as the opener, and macOS WebKit does not focus a button on a mouse click. The script saw the opener unfocused at click in all three mouse cases. The holding panel passes anyway, because `_hpRestoreFocus` (`Worker/app.js:14559`) finds the holding's control again when focus is on the body. Keyboard opening passes | Low | Fixed in v2.89, to be re-confirmed in WebKit on the Mac. Seen in WebKit 27.2 (Mac run) for Add stock, sync details and the More sheet at 390 px. Chromium passes. Firefox not measured, it would not launch. In WebKit, Tab after Escape also stays on the body, because macOS WebKit's default Tab order skips buttons (Safari's "Press Tab to highlight each item" is off by default). Fix: `openModalFocus(overlay, close, opener)` (`Worker/app.js:7008`) takes the opener from each caller, and `_dialogOpener` (`Worker/app.js:7003`) falls back to `document.activeElement` only when none is given. The Columns dialogs get the same rule. The Safari-style click check in `cross-browser.mjs` reproduces the bug on v2.88 in Chromium and passes on v2.89 |
| F2 | WebKit, Safari 17 and earlier (iOS 17 and earlier) | Any modal: Add stock, sync details, column managers | 1. Open any modal on iOS 17. 2. Look at the page behind it. | The dimmed page behind the modal is blurred, as in Chromium | No blur behind the modal, only the flat dim layer. `.overlay` sets `backdrop-filter:blur(4px)` with no `-webkit-` twin (`index.html:420`). Safari only reads the unprefixed property from 18. The modal card itself is fine, it carries both | Low (cosmetic) | Fixed in v2.89. `.overlay` (`index.html:420`) now carries `-webkit-backdrop-filter:blur(4px)` too, and a Node test checks every unprefixed `backdrop-filter` has its twin. Was predicted, not measurable on the Mac. WebKit 27.2 computes the overlay blur as `blur(4px)`, the same as Chromium, so current Safari was never affected. Only Safari 17 or an iOS 17 device can show the fix |
| F3 | Firefox before 121 (ESR 115) | Pages whose head holds only a title | Open any such page in Firefox ESR 115 | The page head drops its bottom margin | The extra margin stays. The rules at `index.html:309` and `index.html:915` use `:has()`, which Firefox only supports from 121, so the whole rule is skipped | Info | Predicted. WebKit 27.2 supports `:has()` and the rule applied. Firefox 157 not measured |
| F4 | WebKit, Safari before 18.2 | Sidebar nav on desktop | Scroll the sidebar nav in Safari 17 | Thin scrollbar | Full-width scrollbar. `scrollbar-width:thin` (`index.html:159`) is ignored before Safari 18.2 | Info | Predicted. WebKit 27.2 supports `scrollbar-width` |
| F5 | WebKit (Safari) | Any page, when the service worker controls it, Chart.js is not in its cache and `cdn.jsdelivr.net` cannot be reached | 1. Let the service worker install while the CDN is unreachable. 2. Reload. | Charts are missing and nothing else is reported (Chromium logs one resource error) | The cache-first branch (`sw.js:65`) awaits `fetch()` with no catch, so `respondWith` rejects. WebKit reports two page errors with no stack, `TypeError: Load failed` and the Chart.js URL, plus a console error. Charts are missing in both engines | Info | Confirmed in WebKit 27.2 with a probe that blocks every external request. Seen only when Chart.js is not cached. A normal install pre-caches it (`sw.js:27`) |

Screenshots for F1 (WebKit and Chromium, after a mouse open, Escape and Tab) were taken on the Mac and stay out of the repo, because they hold the seed figures. The WebKit shot shows no focus ring anywhere. The Chromium shot shows focus on Export CSV, the button after + Add stock.

## Mac run per engine

| Area | What was checked | Chromium 156 | WebKit 27.2 | Firefox 157 |
|---|---|---|---|---|
| Boot | Dashboard is the first page, version badge v2.88 | 1 of 1 | 1 of 1 | Not run |
| Tabs | All 12 pages, dark and light, 1280 px and 390 px. Page active and filled, theme class right, no unexpected console errors, no sideways page scroll | 192 of 192 | 192 of 192 | Not run |
| Sorting | Stocks holdings, Symbol header. aria-sort goes none, ascending, descending and the rows reverse | 1 of 1 | 1 of 1 | Not run |
| Dialogs | + Add menu (keyboard), Add stock modal (keyboard and mouse), sync details, holding panel, command palette (Ctrl+K), More sheet at 390 px. Opens, focus moves inside, Escape closes, focus returns to the opener, no console errors | 33 of 33 | 27 of 33. F1 three times. Blocked-load noise three times (+ Add menu, Add stock by keyboard, Add stock by mouse) | Not run |
| Forms | Add stock. A blank save shows "Required: Symbol". A bad symbol shows the symbol rule. The modal stays open. Nothing is written | 4 of 4 | 4 of 4, same messages as Chromium | Not run |
| CSS | Top bar and sidebar stay pinned after an 800 px scroll | 1 of 1 | 1 of 1 | Not run |
| Service worker | Registers and activates, page controlled after reload, offline reload shows the dashboard with the same figures and no console errors | 5 of 5 | 4 of 5. The offline reload renders and the figures match, the console check failed on F5 noise | Not run |
| Total | | 237 of 237 | 230 of 237 | Did not launch |

## WebKit differences from Chromium

The script lists eight. None is an app defect.

- Long date through raw `Intl`: Chromium `5 March 2026 at 10:07 pm`, WebKit `5 March 2026 at 10:07 PM`. Engine locale data. The app's own `fmtDateSG` matched
- Dashboard headline: both read S$110,500. The script splits `innerText` into lines, and WebKit returns the two figures without a line break (`S$110,500S$110,500`)
- `-webkit-backdrop-filter` is supported in WebKit and not in Chromium. Expected
- Top bar and modal blur (12 px against 14 px) and `--c-stocks-soft` (`#3F62D4` against `#7398FF`): Chromium read the light theme tokens and WebKit the dark ones (`index.html:80`, `index.html:108`, `index.html:61`, `index.html:98`). The script sets dark, then calls `gotoApp` with a hash. Inferred: Chromium treats that as a same-page hash change and does not reload, so it stayed in light. A script issue, not an engine one
- Font family: the same stack (`index.html:88`). Chromium serialises `BlinkMacSystemFont` as `"system-ui"`

Matched in both: the overlay blur (`blur(4px)`), the `:has()` page-head rule, sticky top bar and sidebar, `color-mix()`, subgrid, `100dvh`, `:focus-visible` and `inert`.

## Harness notes

These are fixes to `tests/cross-browser.mjs`, separate from any app fix. All three are fixed in v2.89.

- The expected-error filter missed WebKit's wording for blocked loads: `Failed to preconnect to https://fonts.gstatic.com/` and the F5 page errors. That caused four of the seven WebKit failures. Fixed: a console error that names an external URL with blocked-load wording is expected. A page error of `TypeError: Load failed` or a bare external URL is expected only once the engine has had a request blocked. `node Portfolio/tests/cross-browser.mjs --self-test` checks the filter against the Mac run's wording with no browser (12 of 12). Not verified: the exact wording of the F5 console error, which the Mac rerun will show
- The dialog checks called `gotoApp` without clearing the console sink, so load-time errors landed in whichever dialog check followed a reload. Fixed: the sink is cleared before each check and again after its reload
- `gotoApp` with a hash did not reload Chromium, so the CSS probe compared light Chromium with dark WebKit. Fixed: `gotoApp` marks the old document and reloads when a hash-only `goto` kept it. The CSS probe sets dark first and records `theme is dark`. Chromium now reads the dark `--c-stocks-soft` (`#7398FF`)

## Firefox launch failure

- Firefox 157.0 (build 1555, `firefox-mac-arm64.zip`, 110,873,383 bytes from `cdn.playwright.dev`) downloaded and installed cleanly
- Every launch exits with code 1 and prints only "Could not find profile folder." The text sits beside Firefox's own profile-missing dialog strings in `XUL`
- Same result through Playwright, through a direct launch, with a fresh empty profile folder, with `HOME` redirected, with `XRE_PROFILE_PATH` set and outside the command sandbox. Firefox never creates its app-data folder and writes nothing to `MOZ_LOG`
- Chromium and WebKit launch fine on the same Mac. Inferred, not verified: this Firefox build cannot resolve its macOS user folders on macOS 27.0.1. A web search found no report of this exact error on macOS
- Next try: a newer Playwright Firefox build, which needs another download

## How the app renders with no backend

- With no sync URL stored, the app boots in local-only mode. The sidebar status reads Local only and nothing calls Apps Script.
- The QA seed loads through localStorage. The script writes the seed (minus `_priceCache`) to `kjr-pf-db-v1`, the seed's `_priceCache` to `kjr-pf-price-cache-v1`, and sets `kjr-pf-wizard-dismissed-v1`. This happens once per context before any app script runs.
- The seed has no schema version, so the app runs its migrations on load. Migration 2 clears `tabCurrency`, so Stocks and Watchlist show USD (the app default). This is expected, not a defect.
- Every page renders meaningfully. The dashboard headline reads S$110,500 in Chromium and WebKit, the seed's net worth excluding CPF (S$120,500 with CPF, matching `test-values.js`).
- Chart.js comes from `cdn.jsdelivr.net`, which the guard blocks. `window.Chart` is undefined, so no chart draws. The app degrades cleanly. The npm copy of Chart.js 4.4.1 is the unminified build, so its hash does not match the pinned SRI and it cannot stand in offline.
- The Manrope web font is blocked too, so text falls back to the system font stack.

## Values compared

Chromium gave these on the Linux run. On the Mac, WebKit matched Mac Chromium on all of them except the long date (`PM` against `pm`).

- Intl, en-SG: SGD `$1,234,567.89`, USD `US$1,234,567.89`, HKD `HK$1,234,567.89`, compact `1.2M`, percent `12.3%`
- Intl dates, Asia/Singapore: medium `5 Mar 2026`, long `5 March 2026 at 10:07 pm`, en-GB weekday `Thursday 5 March`
- App helpers: `fmt` gives `S$1,234,567.89` and `-US$9,876.50`, signed `+S$42.00`, `fmtCompact` `S$3.21T`, `fmtDateSG` `31/03/2026`, `fmtPct` `▼ -1.23%`
- CSS support: `:has()`, unprefixed `backdrop-filter`, `color-mix()`, subgrid, `100dvh`, `scrollbar-width`, `:focus-visible` and `inert` all supported. The app uses no scroll snapping and no `<dialog>` element. Its dialogs are `div[role=dialog]` overlays with a script focus trap

## Blocked outbound URLs

Every request outside localhost was refused. Nothing reached a live service. No request went to Apps Script, Yahoo, the Trading Worker, the NAS or Supabase, and storage held no sync URL and no `nas` backend mode.

Mac run, 7 entries:

- Chromium and WebKit, context route: `https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&display=swap` and `https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js`
- WebKit, black-hole proxy: `https://fonts.googleapis.com:443`, `https://fonts.gstatic.com:443` and `https://cdn.jsdelivr.net:443` (preconnects and the service worker fetch)

Linux run: the same two app URLs from the context route, plus six of Chromium's own background hosts at the proxy (`accounts.google.com`, `update.googleapis.com`, `www.google.com`, `content-autofill.googleapis.com`, `android.clients.google.com`, `redirector.gvt1.com`, all on port 443).

## Not tested

- Firefox, all checks. Playwright's Firefox 157 would not launch on macOS 27.0.1 (see Firefox launch failure)
- Real Safari. Playwright WebKit is not Safari. It lacks Safari's own features (autofill, Keychain, content blockers, Intelligent Tracking Prevention storage limits) and is a newer engine than Safari 17, so F2 and F4 stay predicted
- A real iPhone: the iOS layout engine, the bottom bar and safe areas
- The PWA install (Add to Home Screen)
- Touch input. The 390 px pass uses a narrow desktop viewport with mouse and keyboard events
- Screen readers (VoiceOver, NVDA). The focus checks cover keyboard focus only
- Charts of every kind (hero chart, Explore, holding panel 3-month chart), because Chart.js is blocked
- Live prices, sync, backup and restore, all of which need Apps Script

## Outside scope, seen while running the suites

- v2.89 Linux run: still the same. `npm test` stops at `check-nas-config.js`. With a test-only `stat` shim on `PATH` that answers `stat -f '%Lp'` as macOS does, the whole chain passes, 14 of 14 scripts.

- `npm test` from `Portfolio/` fails on Linux at `tests/check-nas-config.js` (29 checks). It fails the same way with this change removed. One cause: `mode_is_600` in `NAS/backup.sh:119` and `NAS/restore.sh:133` tries BSD `stat -f '%Lp'` first. GNU `stat` reads that as filesystem mode, prints a block of output and exits 1. The output is still captured, so the `stat -c '%a'` fallback's `600` never stands alone and the check fails. On a NAS with GNU coreutils, backup and restore would always stop with "env file must have mode 600". The other 13 scripts in the chain pass.

## Rerun

On the Mac, Playwright 1.64.0 already sits in the npx cache and Chromium, WebKit and Firefox are installed under `~/Library/Caches/ms-playwright`. Serve the repo root on port 3807 (`.claude/launch.json` entry, or `npx serve -l 3807 .`), then from the repo root:

```bash
KJR_PLAYWRIGHT="$HOME/.npm/_npx/e41f203b7505f1fb/node_modules/playwright" node Portfolio/tests/cross-browser.mjs --out="$TMPDIR/kjr-browser-qa"
```

The filter self-test needs no server and no browser:

```bash
node Portfolio/tests/cross-browser.mjs --self-test
```

On a fresh machine, install first:

```bash
npx -y playwright@1.64.0 install chromium webkit firefox
```

The script exits 0 when every engine passes, 1 on a failed check or an engine that will not launch, 2 on a safety violation. The report lands in `report.json` in the output folder, with a `diffs` list against Chromium.

*Disposable point-in-time doc. Delete once fully actioned (see CLAUDE.md, Files and hygiene).*
