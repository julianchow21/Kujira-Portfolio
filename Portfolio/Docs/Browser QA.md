# Portfolio Browser QA

Cross-browser smoke pass of the Portfolio app on 03/11/2026. v2.88 ran twice (Linux and Mac) with Playwright 1.64.0. v2.89 ran on Linux with 1.64.0 and on the Mac with 1.64.0 and 1.64.1.

- Linux run (cloud session): Chromium 153 only, because the network policy blocked the WebKit and Firefox downloads
- Mac run (macOS 27.0.1, Apple silicon): Chromium 156.0.8078.4, WebKit 27.2 and Firefox 157.0 (build 1555)
- Firefox launched on the v2.89 Mac run only, with the `CFFIXED_USER_HOME` workaround (see Firefox launch failure)

## v2.89 update (03/11/2026)

- F1 is fixed in v2.89 and confirmed on the Mac. Every dialog now gets its opener from the caller, so a Safari mouse click returns focus to the button. WebKit 27.2 passes the three real-mouse cases that failed on v2.88, with the opener unfocused at the click each time
- F2 is fixed in v2.89. `.overlay` now carries `-webkit-backdrop-filter:blur(4px)` beside the unprefixed rule. It is the only unprefixed `backdrop-filter` in the app. Only Safari 17 or an iOS 17 device can show the blur.
- Four harness misses are fixed. See Harness notes.
- `cross-browser.mjs` has a new Safari-style click check. It blurs focus, dispatches the click without focusing the opener, presses Escape and asserts focus is back on the opener. It covers Add stock, + Add menu then Stock, sync details, the holding panel, the palette button, stock Columns, the setup wizard and the More sheet at 390 px.
- Linux run, Chromium 153 only. The network policy blocked the WebKit and Firefox downloads again (HTTP 403 from the proxy for `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`).
- On v2.88 the Safari-style check failed six times in Chromium, focus landed on the body. The holding panel and the + Add menu passed, as in WebKit. On v2.89 Chromium passes 283 of 283.
- Mac run on v2.89 with Playwright 1.64.0: Chromium 283 of 283, WebKit 282 of 283. The one miss was an F5 page error in a wording the filter did not know
- After the filter fix, WebKit passes 283 of 283 (Playwright 1.64.0, no workaround variable)
- One pass of all three engines on Playwright 1.64.1: Chromium 283 of 283, WebKit 283 of 283, Firefox 157.0 281 of 283
- Playwright 1.64.1 is the newest release (`npm view playwright version`). It pins the same Chromium, WebKit and Firefox builds as 1.64.0 (1248, 2370 and 1555), so nothing new was downloaded
- Firefox launches when `CFFIXED_USER_HOME` points at an empty folder. Its two misses are the offline reload under Playwright's `setOffline`, a harness limit (F6)

## Bottom line

v2.89 Mac run, Playwright 1.64.1, all three engines in one pass:

- Chromium 156 passed 283 of 283 and WebKit 27.2 passed 283 of 283, both with zero unexpected console errors
- Firefox 157.0 passed 281 of 283. Both misses are the offline reload, where Playwright's `setOffline` makes Firefox refuse the navigation before the service worker answers (F6). With the server shut down for real, Firefox serves the dashboard from the cache with the same figures
- No Firefox-only app defect turned up. Firefox matched Chromium on every value the script compares, apart from how it writes the font stack
- F1 is confirmed fixed in WebKit. Firefox cannot show it through Playwright, because Playwright's click focuses the button, where a native macOS click is predicted not to. The Safari-style checks pass in Firefox
- F2 is neither confirmed nor cleared. WebKit 27.2 and Firefox 157 compute the blur, but neither paints any backdrop blur in Playwright's headless screenshots, not even on a one-overlay test page (F7)
- In WebKit and Firefox, every app value the script compares matched Chromium: the money and date helpers, the form validation messages and the dashboard headline. The differences it lists come from engine wording and a script reading quirk
- v2.88 for the record: Chromium 237 of 237 on Linux and on the Mac, WebKit 230 of 237 (three F1 failures and four blocked-load wordings the filter missed), Firefox did not launch

## Findings

Status key: Confirmed means seen in a browser. Predicted means read from the code and not yet seen in a browser.

| ID | Engine | Page | Steps to reproduce | Expected | Actual | Severity | Status |
|---|---|---|---|---|---|---|---|
| F1 | WebKit on macOS (Safari). Firefox on macOS predicted | Dialogs opened with a mouse click: Add stock, sync details, More sheet | 1. Open Stocks. 2. Click + Add stock with the mouse. 3. Press Escape. 4. Press Tab. | Focus goes back to the + Add stock button, so Tab carries on from there | Focus lands on the page body. `openModalFocus` (`Worker/app.js:7000`) stores `document.activeElement` as the opener, and macOS WebKit does not focus a button on a mouse click. The script saw the opener unfocused at click in all three mouse cases. The holding panel passes anyway, because `_hpRestoreFocus` (`Worker/app.js:14559`) finds the holding's control again when focus is on the body. Keyboard opening passes | Low | Fixed in v2.89 and re-confirmed in WebKit 27.2 on the Mac (03/11/2026). The three real-mouse cases and the Safari-style cases all pass, and the opener was still unfocused at the click each time. Seen on v2.88 in WebKit 27.2 for Add stock, sync details and the More sheet at 390 px. Chromium passes. Firefox 157: Playwright's click focuses the button (the opener held focus at the click in all three real-mouse cases), so the native macOS case cannot be reproduced with a real mouse event there. All 79 dialog checks pass in Firefox, the Safari-style ones included. In WebKit, Tab after Escape also stays on the body, because macOS WebKit's default Tab order skips buttons (Safari's "Press Tab to highlight each item" is off by default). Fix: `openModalFocus(overlay, close, opener)` (`Worker/app.js:7008`) takes the opener from each caller, and `_dialogOpener` (`Worker/app.js:7003`) falls back to `document.activeElement` only when none is given. The Columns dialogs get the same rule. The Safari-style click check in `cross-browser.mjs` reproduces the bug on v2.88 in Chromium and passes on v2.89 |
| F2 | WebKit, Safari 17 and earlier (iOS 17 and earlier) | Any modal: Add stock, sync details, column managers | 1. Open any modal on iOS 17. 2. Look at the page behind it. | The dimmed page behind the modal is blurred, as in Chromium | No blur behind the modal, only the flat dim layer. `.overlay` sets `backdrop-filter:blur(4px)` with no `-webkit-` twin (`index.html:420`). Safari only reads the unprefixed property from 18. The modal card itself is fine, it carries both | Low (cosmetic) | Fixed in v2.89. `.overlay` (`index.html:420`) now carries `-webkit-backdrop-filter:blur(4px)` too, and a Node test checks every unprefixed `backdrop-filter` has its twin. Was predicted, not measurable on the Mac. WebKit 27.2 computes the overlay blur as `blur(4px)`, the same as Chromium, so current Safari was never affected. Firefox 157 computes the same value. Neither engine paints the blur in a Playwright screenshot (F7), so the paint was not seen. Only Safari 17 or an iOS 17 device can show the fix |
| F3 | Firefox before 121 (ESR 115) | Pages whose head holds only a title | Open any such page in Firefox ESR 115 | The page head drops its bottom margin | The extra margin stays. The rules at `index.html:309` and `index.html:915` use `:has()`, which Firefox only supports from 121, so the whole rule is skipped | Info | Predicted for Firefox before 121. WebKit 27.2 and Firefox 157 both support `:has()` and the rule applied (measured) |
| F4 | WebKit, Safari before 18.2 | Sidebar nav on desktop | Scroll the sidebar nav in Safari 17 | Thin scrollbar | Full-width scrollbar. `scrollbar-width:thin` (`index.html:159`) is ignored before Safari 18.2 | Info | Predicted. WebKit 27.2 and Firefox 157 support `scrollbar-width` |
| F5 | WebKit (Safari) | Any page, when the service worker controls it, Chart.js is not in its cache and `cdn.jsdelivr.net` cannot be reached | 1. Let the service worker install while the CDN is unreachable. 2. Reload. | Charts are missing and nothing else is reported (Chromium logs one resource error) | The cache-first branch (`sw.js:65`) awaits `fetch()` with no catch, so `respondWith` rejects. WebKit reports two page errors with no stack, `TypeError: Load failed` and the Chart.js URL, plus a console error. In the v2.89 Mac run the URL arrived as `/cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js.` (see Harness notes). Charts are missing in both engines | Info | Confirmed in WebKit 27.2 with a probe that blocks every external request, and again with the dev server shut down for real. Seen only when Chart.js is not cached. A normal install pre-caches it (`sw.js:27`). Chromium and Firefox logged no page error in the same offline reload |
| F6 | Firefox 157 under Playwright (harness limit) | Service worker offline reload, dashboard | 1. Run `cross-browser.mjs --engines=firefox`. 2. The script sets the context offline with `setOffline(true)` and reloads the dashboard | The dashboard renders from the service worker cache, as in Chromium and WebKit | `page.reload: NS_ERROR_OFFLINE`, so "offline reload renders the dashboard from cache" and "offline figures match online" fail. With a throwaway server shut down instead (ECONNREFUSED), Firefox 157 reloads from the service worker, shows 12 nav links and the same figures, and logs no page error. Chromium and WebKit pass the same check both ways | None for the app | Confirmed as a harness limit, not an app defect. Not fixed in this pass, because the packet limited script edits to the error filter. Suggested fix: for Firefox, take the server away instead of calling `setOffline` |
| F7 | WebKit 27.2 and Firefox 157, Playwright headless on macOS | Any modal, such as Add stock | 1. Open Add stock with `--engines=firefox` or `--engines=webkit`. 2. Wait 1.2 s and take a screenshot. 3. Compare with Chromium | The page behind the dim layer is blurred, as in Chromium | The page behind is dim and sharp, and its figures show through the modal card (the card is 7% white). Computed styles match Chromium: overlay `blur(4px)`, card `blur(14px)`, opacity 1, no transition. A test page with one `backdrop-filter:blur(6px)` overlay also paints no blur in either engine, so these builds paint no backdrop blur in this setup, whatever the page does | Info | Confirmed as a test limit, not an app defect. Real Safari and Firefox are not measured, and a headed run was not tried. Inferred: if a user's browser supports the property but paints none, the card is hard to read, and the `@supports not (backdrop-filter)` fallback cannot catch that |

Screenshots for F1 (WebKit and Chromium, after a mouse open, Escape and Tab) were taken on the Mac and stay out of the repo, because they hold the seed figures. The WebKit shot shows no focus ring anywhere. The Chromium shot shows focus on Export CSV, the button after + Add stock.

## Mac run per engine

Counts are from the v2.89 run on Playwright 1.64.1, all three engines in one pass. The v2.88 counts are in the Bottom line.

| Area | What was checked | Chromium 156 | WebKit 27.2 | Firefox 157 |
|---|---|---|---|---|
| Boot | Dashboard is the first page, version badge v2.89 | 1 of 1 | 1 of 1 | 1 of 1 |
| Tabs | All 12 pages, dark and light, 1280 px and 390 px. Page active and filled, theme class right, no unexpected console errors, no sideways page scroll | 192 of 192 | 192 of 192 | 192 of 192 |
| Sorting | Stocks holdings, Symbol header. aria-sort goes none, ascending, descending and the rows reverse | 1 of 1 | 1 of 1 | 1 of 1 |
| Dialogs | + Add menu (keyboard), Add stock modal (keyboard, mouse and Safari-style click), + Add menu then Stock, sync details, holding panel, command palette (Ctrl+K and Safari-style click), stock Columns, setup wizard, More sheet at 390 px. Opens, focus moves inside, Escape closes, focus returns to the opener, no console errors, and for Safari-style clicks the opener was unfocused at the click | 79 of 79 | 79 of 79 | 79 of 79 |
| Forms | Add stock. A blank save shows "Required: Symbol". A bad symbol shows the symbol rule. The modal stays open. Nothing is written | 4 of 4 | 4 of 4, same messages as Chromium | 4 of 4, same messages as Chromium |
| CSS | Top bar and sidebar stay pinned after an 800 px scroll | 1 of 1 | 1 of 1 | 1 of 1 |
| Service worker | Registers and activates, page controlled after reload, offline reload shows the dashboard with the same figures and no console errors | 5 of 5 | 5 of 5 | 3 of 5. The offline reload fails on Playwright's `setOffline` (F6), and the figures check fails with it |
| Total | | 283 of 283 | 283 of 283 | 281 of 283 |

## WebKit differences from Chromium

The script lists five on v2.89 (eight on v2.88). None is an app defect.

- Long date through raw `Intl`: Chromium `5 March 2026 at 10:07 pm`, WebKit `5 March 2026 at 10:07 PM`. Engine locale data. The app's own `fmtDateSG` matched
- Dashboard headline: both read S$110,500. The script splits `innerText` into lines, and WebKit returns the two figures without a line break (`S$110,500S$110,500`)
- `-webkit-backdrop-filter` is supported in WebKit and not in Chromium. Expected
- Top bar `-webkit-backdrop-filter` computes `blur(14px)` in WebKit and an empty string in Chromium, for the same reason
- Font family: the same stack (`index.html:88`). Chromium serialises `BlinkMacSystemFont` as `"system-ui"`
- The three v2.88 differences from a theme mismatch are gone (top bar and modal blur 12 px against 14 px, and `--c-stocks-soft`). The script now reloads after setting the theme, so Chromium reads the dark tokens too

Matched in WebKit and Chromium: the overlay blur (computed `blur(4px)`), the `:has()` page-head rule, sticky top bar and sidebar, `color-mix()`, subgrid, `100dvh`, `:focus-visible` and `inert`.

## Firefox differences from Chromium

The script lists one. It is not an app defect.

- Font family: the same stack (`index.html:88`). Firefox writes `"Manrope"` in quotes and keeps `BlinkMacSystemFont`, where Chromium writes `Manrope` bare and `"system-ui"` for `BlinkMacSystemFont`

Matched in Firefox and Chromium: every `Intl` and app helper value, the form validation messages, the overlay blur (computed `blur(4px)`), the `:has()` page-head rule, sticky top bar and sidebar, `color-mix()`, subgrid, `100dvh`, `scrollbar-width`, `:focus-visible` and `inert`. Firefox does not support `-webkit-backdrop-filter`, like Chromium.

## Harness notes

These are fixes to `tests/cross-browser.mjs`, separate from any app fix. All four are fixed.

- The expected-error filter missed WebKit's wording for blocked loads: `Failed to preconnect to https://fonts.gstatic.com/` and the F5 page errors. That caused four of the seven WebKit failures on v2.88. Fixed: a console error that names an external URL with blocked-load wording is expected. A page error of `TypeError: Load failed` or a bare external URL is expected only once the engine has had a request blocked. The F5 console error did not fail any check, and its text was not recorded
- The F5 page error did not arrive as a bare URL. WebKit's reads `/cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js.`, with the scheme and one slash gone. Playwright builds a WebKit page error from a console error by splitting the text at its first colon and keeping the text from two characters on (`splitErrorMessage` in `playwright-core`, read in 1.64.0). It cost the last WebKit check on the v2.89 Mac run (282 of 283). Fixed: the filter puts `https:/` back when the message is a slash, a dotted host and a path, then applies the same rule as for a bare external URL, so it counts as expected only after that engine has had a request blocked
- An app-origin page error still counts as unexpected, in the scheme-less shape too (`/localhost:3807/...`, `/127.0.0.1:3807/...`) and as a bare file name (`/sw.js`). `node Portfolio/tests/cross-browser.mjs --self-test` checks 17 cases (12 before) and passes, with no browser
- The dialog checks called `gotoApp` without clearing the console sink, so load-time errors landed in whichever dialog check followed a reload. Fixed: the sink is cleared before each check and again after its reload
- `gotoApp` with a hash did not reload Chromium, so the CSS probe compared light Chromium with dark WebKit. Fixed: `gotoApp` marks the old document and reloads when a hash-only `goto` kept it. The CSS probe sets dark first and records `theme is dark`. Chromium now reads the dark `--c-stocks-soft` (`#7398FF`)
- Open, not fixed: `context.setOffline(true)` makes Firefox refuse the offline reload (F6)

## Firefox launch failure

First Mac run:

- Firefox 157.0 (build 1555, `firefox-mac-arm64.zip`, 110,873,383 bytes from `cdn.playwright.dev`) downloaded and installed cleanly
- Every launch exited with code 1 and printed only "Could not find profile folder." The text sits beside Firefox's own profile-missing dialog strings in `XUL`
- Same result through Playwright, through a direct launch, with a fresh empty profile folder, with `HOME` redirected, with `XRE_PROFILE_PATH` set and outside the command sandbox. Firefox never created its app-data folder and wrote nothing to `MOZ_LOG`

Retry on 03/11/2026, what was tried and what came out:

- Playwright 1.64.1 is the newest release and pins the same Firefox build 1555. `install --dry-run firefox` shows it already installed (`INSTALLATION_COMPLETE`), so nothing was downloaded
- Bare launch with 1.64.1 failed as before. The log read `*** You are running in headless mode.` then `Could not find profile folder.`, then `process did exit: exitCode=1`
- A direct launch of the binary with a fresh profile folder under scratch, `MOZ_FORCE_DISABLE_E10S=1` set and unset, printed the same two lines and exited 1. `firefox --version` works (`Mozilla Firefox 157.0`)
- Playwright 1.64.0 `launchPersistentContext` with a fresh scratch profile and `MOZ_FORCE_DISABLE_E10S=1` failed the same way
- `HOME` and `CFFIXED_USER_HOME` both pointed at a scratch folder: a direct launch ran until the 20 s timer killed it (exit 142), so it had started. Playwright then could not find its browsers, because it reads `HOME` for its cache path
- `CFFIXED_USER_HOME` alone pointed at a new empty scratch folder: Playwright 1.64.1 launched Firefox 157.0 and closed it in 1.1 s. Firefox created `Library/Application Support/Firefox`, `Library/Caches/Firefox`, `Library/.localized` and `Downloads/.localized` in that folder
- Control, `CFFIXED_USER_HOME` set to the real home: it failed as before
- Not tried: Playwright's `next` channel (1.65.0-alpha-2026-11-02). `browsers.json` on Playwright's `main` branch lists Firefox 159.0 (build 1572), read through a web fetch and not checked against the alpha package

Workaround: run Firefox with `CFFIXED_USER_HOME` set to an empty writable folder, for example `CFFIXED_USER_HOME="$(mktemp -d)"`. Leave `HOME` alone.

The cause is not isolated. This session cannot list `~/Downloads`, `~/Documents` or `~/Desktop` (Operation not permitted), and Firefox creates `Downloads/.localized` in a scratch home. Inferred, not verified: Firefox's start-up touches the real home's protected folders and macOS refuses it for processes started from this session. A plain Terminal run without the variable was not tried, so it is unknown whether Julian's own Terminal needs the workaround.

## How the app renders with no backend

- With no sync URL stored, the app boots in local-only mode. The sidebar status reads Local only and nothing calls Apps Script.
- The QA seed loads through localStorage. The script writes the seed (minus `_priceCache`) to `kjr-pf-db-v1`, the seed's `_priceCache` to `kjr-pf-price-cache-v1`, and sets `kjr-pf-wizard-dismissed-v1`. This happens once per context before any app script runs.
- The seed has no schema version, so the app runs its migrations on load. Migration 2 clears `tabCurrency`, so Stocks and Watchlist show USD (the app default). This is expected, not a defect.
- Every page renders meaningfully. The dashboard headline reads S$110,500 in Chromium, WebKit and Firefox, the seed's net worth excluding CPF (S$120,500 with CPF, matching `test-values.js`).
- Chart.js comes from `cdn.jsdelivr.net`, which the guard blocks. `window.Chart` is undefined, so no chart draws. The app degrades cleanly. The npm copy of Chart.js 4.4.1 is the unminified build, so its hash does not match the pinned SRI and it cannot stand in offline.
- The Manrope web font is blocked too, so text falls back to the system font stack.

## Values compared

Chromium gave these on the Linux run. On the Mac, WebKit matched Mac Chromium on all of them except the long date (`PM` against `pm`), and Firefox matched Mac Chromium on all of them.

- Intl, en-SG: SGD `$1,234,567.89`, USD `US$1,234,567.89`, HKD `HK$1,234,567.89`, compact `1.2M`, percent `12.3%`
- Intl dates, Asia/Singapore: medium `5 Mar 2026`, long `5 March 2026 at 10:07 pm`, en-GB weekday `Thursday 5 March`
- App helpers: `fmt` gives `S$1,234,567.89` and `-US$9,876.50`, signed `+S$42.00`, `fmtCompact` `S$3.21T`, `fmtDateSG` `31/03/2026`, `fmtPct` `▼ -1.23%`
- CSS support: `:has()`, unprefixed `backdrop-filter`, `color-mix()`, subgrid, `100dvh`, `scrollbar-width`, `:focus-visible` and `inert` all supported. The app uses no scroll snapping and no `<dialog>` element. Its dialogs are `div[role=dialog]` overlays with a script focus trap

## Blocked outbound URLs

Every request outside localhost was refused. Nothing reached a live service. No request went to Apps Script, Yahoo, the Trading Worker, the NAS or Supabase, and storage held no sync URL and no `nas` backend mode.

Mac v2.89 run, all three engines, 11 entries:

- Chromium, WebKit and Firefox, context route: `https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&display=swap` and `https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js`
- WebKit, black-hole proxy: `https://fonts.googleapis.com:443`, `https://fonts.gstatic.com:443` and `https://cdn.jsdelivr.net:443` (preconnects and the service worker fetch)
- Firefox, black-hole proxy: `https://cdn.jsdelivr.net:443` (the service worker fetch) and `https://aus5.mozilla.org:443` (Firefox's own update check, which comes from the browser and not the app)

Linux run: the same two app URLs from the context route, plus six of Chromium's own background hosts at the proxy (`accounts.google.com`, `update.googleapis.com`, `www.google.com`, `content-autofill.googleapis.com`, `android.clients.google.com`, `redirector.gvt1.com`, all on port 443).

## Not tested

- Firefox from a plain Terminal without `CFFIXED_USER_HOME`. The cause of the launch failure is not isolated
- Firefox ESR 115 and other versions before 157, so F3 stays predicted for them
- Backdrop blur painting in WebKit and Firefox. Playwright's headless builds paint none on this Mac (F7), and a headed run (`--headed`) was not tried
- Playwright's `next` channel and the Firefox 159.0 build it is expected to pin
- Real Safari. Playwright WebKit is not Safari. It lacks Safari's own features (autofill, Keychain, content blockers, Intelligent Tracking Prevention storage limits) and is a newer engine than Safari 17, so F2 and F4 stay predicted
- A real iPhone: the iOS layout engine, the bottom bar and safe areas
- The PWA install (Add to Home Screen)
- Touch input. The 390 px pass uses a narrow desktop viewport with mouse and keyboard events
- Screen readers (VoiceOver, NVDA). The focus checks cover keyboard focus only
- Charts of every kind (hero chart, Explore, holding panel 3-month chart), because Chart.js is blocked
- Live prices, sync, backup and restore, all of which need Apps Script

## Outside scope, seen while running the suites

- v2.89 Mac run (03/11/2026): `npm test` from `Portfolio/` passes, 14 of 14 scripts, exit 0. The GNU `stat` failure below did not appear on macOS.

- v2.89 Linux run: still the same. `npm test` stops at `check-nas-config.js`. With a test-only `stat` shim on `PATH` that answers `stat -f '%Lp'` as macOS does, the whole chain passes, 14 of 14 scripts.

- `npm test` from `Portfolio/` fails on Linux at `tests/check-nas-config.js` (29 checks). It fails the same way with this change removed. One cause: `mode_is_600` in `NAS/backup.sh:119` and `NAS/restore.sh:133` tries BSD `stat -f '%Lp'` first. GNU `stat` reads that as filesystem mode, prints a block of output and exits 1. The output is still captured, so the `stat -c '%a'` fallback's `600` never stands alone and the check fails. On a NAS with GNU coreutils, backup and restore would always stop with "env file must have mode 600". The other 13 scripts in the chain pass.

## Rerun

On the Mac, Playwright 1.64.0 already sits in the npx cache and Chromium, WebKit and Firefox are installed under `~/Library/Caches/ms-playwright`. Serve the repo root on port 3807 (`.claude/launch.json` entry, or `npx serve -l 3807 .`), then from the repo root:

```bash
CFFIXED_USER_HOME="$(mktemp -d)" KJR_PLAYWRIGHT="$HOME/.npm/_npx/e41f203b7505f1fb/node_modules/playwright" node Portfolio/tests/cross-browser.mjs --out="$TMPDIR/kjr-browser-qa"
```

`CFFIXED_USER_HOME` is only there for Firefox. Without it Firefox does not launch from the session that ran this pass, and the other two engines still run. Until the script takes the server away for Firefox, expect the two F6 failures in the service worker offline reload. Playwright 1.64.1 gives the same results on the same browser builds. The command above was run as written, with `--out` pointed at a scratch folder, and gave Chromium 283 of 283, WebKit 283 of 283 and Firefox 281 of 283.

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
