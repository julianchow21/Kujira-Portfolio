# Kujira Portfolio

Personal net-worth tracker: SGX/US stocks, crypto, real estate, insurance, cash, CPF, salary, P&L, projections and a configurable watchlist. SGD base. Dual light/dark theme. PWA (Add to Home Screen). Deployed on GitHub Pages.

## Architecture

`index.html` at the app root, support sources in `Worker/`:

- `Worker/app.js`, the app logic
- `Worker/kjr-core.js`, pure, side-effect-free logic (no DOM, no localStorage, no fetch). Loaded as a `<script src>` global in the browser, also `require()`-able from `tests/` under node. **Keep pure.**
- `Worker/kjr-sortable.js`, drag-sort helper
- `Worker/kjr-vault.js`, optional passphrase-derived AES-GCM protection for sensitive browser storage
- `Worker/kjr-migration.js`, legacy blob migration (`KjrMigration`): validates a parsed legacy database, builds a detached plan and hashes it, no browser or Node dependency
- `Worker/supabase.js`, the vendored `@supabase/supabase-js` UMD bundle (global `supabase`), pinned in `Worker/supabase.pin` with its licence beside it
- `Worker/kjr-nas.js`, the NAS controller (`KjrNas`): takes a Supabase client and an encrypted storage facade from the caller, owns no browser state, hydrates, stages and flushes records
- `Worker/theme-init.js`, blocking theme init (FOUC guard)
- `Worker/apps-script.gs`, Google Apps Script backend deployed as a Web App. Handles `read`, `write`, `backup`, `restore`, `seed`, and `fundamentals` actions. Julian re-deploys manually at script.google.com after every `.gs` change.

Chart.js 4.4.1 (CDN, SRI-pinned). The live backend is Google Apps Script + Google Sheets, with no sign-in and no row-level security on that path. A private same-origin Supabase NAS candidate ships dormant: `index.html` loads `Worker/supabase.js` and `Worker/kjr-nas.js` on every page, but `NAS_RELEASE_ENABLED` is `false` in `Worker/app.js`, so activation, the NAS controller and every NAS write are refused and no Supabase client is ever created. Its schema, with RLS, is `Supabase/schema.sql` and its deployment kit is `NAS/`.

## Tabs

| Tab | Key | Status |
|---|---|---|
| Dashboard | `dashboard` | Live |
| Stocks | `stocks` | Live |
| Watchlist | `board` | Live (page title Watchlist+) |
| Crypto | `crypto` | Live (v2.47, CoinGecko via Apps Script) |
| Real estate | `realestate` | Live |
| Insurance | `insurance` | Live (merged from the standalone module, v2.43) |
| Cash | `cash` | Live |
| CPF | `cpf` | Live |
| Income & spending | `cashflow` | Live (renamed from P&L in v2.72) |
| Projections | `projections` | Live (v2.45, FIRE + CPF trajectory in today's dollars) |
| Explore | `explore` | Live (v2.70, Chart Builder and the saved charts list) |
| Settings | `settings` | Live |

`PHASE_2_TABS` is currently empty. To park a future tab without deleting its markup, add its key to this set. Remove the key when the tab is ready to return to the live navigation.

**Navigation (v2.72):** above 768 px a 224 px left sidebar (`--sidebar` surface) holds the workspace switcher (Trading and Forex as real anchors), the `NAV_GROUPS` (Overview, Assets with counts from `NAV_COUNT_TABLES`, Money) and a footer with Settings, the sync row, the guide link, the theme switch and the version badge. A compact top bar shows the page title and status, the per-tab currency switch, Hide amounts and the `+ Add` menu (`ADD_MENU_ITEMS`). At 768 px and below, a header plus a five-item bottom bar (`MOBILE_GROUPS`: Overview, Assets, Money, Plan, More) opens one shared sheet. Every renderer honours `PHASE_2_TABS`.

**Mobile lists (v2.73):** at 640 px and below, Stocks, Crypto, Cash (accounts and ledger) and CPF history swap their tables for list rows built from the same row models in the same render pass (`_stockListModel`, `_cryptoListModel`, `_cashListModel`, `_cashTxnView`, `_cpfRowView`), so the list and the desktop table can never disagree. Filters become a scrolling chip row of native selects bound to the desktop state, and actions become one + Add plus a More menu (`MORE_MENU_ACTIONS` whitelist). Holding rows open through `openHoldingDetail(table, id)`. Desktop tables, sorting and Columns are unchanged. Since v2.76 the Stocks page's Watchlist, Upcoming dividends and Trade history do the same (`_wlListModel`, `_dividendView`, `_stockTxnView`): the table is `.hd-only` and a `.hl hl-2` list sits beside it. A trade row opens Edit like Cash does, a dividend row only reads, and a Watchlist row is a div of an Edit button plus an Analyse link (a link cannot sit inside a button). The By stock view's headings (`.hl-group`) and position lines (`.hl-total`) are rows too.

**Holding panel and palette (v2.74):** `openHoldingDetail(table, id)` opens the holding side panel (`#holding-panel`, built by `_holdingPanelModel`, with a 3-month chart from `fetchStockHistory` using the key `THREE_MONTHS`, never the bare string `3mo`). ⌘K or Ctrl+K opens the command palette (`_paletteResults` is pure), and the shortcut stays blocked while the vault or NAS gate, any open overlay or the panel is up.

**Motion, privacy and Undo (v2.75):** `_reducedMotion()` gates every JS animation, and every CSS keyframe has a `prefers-reduced-motion` override. Hide amounts blurs amounts at 7 px. Percentage cells carry `.pct` and stay readable, so tag any new percentage cell the same way. The hero headline rolls between renders (`_heroShown`, `_heroRollPlan`), never on scrub. Refreshes snapshot `_priceCache` (`_priceSnapshot`, `_priceDiff`) and flash changed rows that carry `data-px`. Skeletons show only while a fetch is in flight and no visible holding has a price. Deleting a record that nothing references shows an Undo toast instead of a confirm, and since v2.76 so does deleting a saved chart (`pbDeleteSaved`: no dialog, each toast's Undo carries its own chart and the ids beside it through `_pbRestoreFor` and `_pbOrderMemo`, so two quick deletes undo in either order). Cascading deletes, `cleanOrphanedTrades` and every irreversible or bulk action still confirm. A background price refresh is silent: `autoRefreshTick` passes `{ silent:true }` to `refreshStockPrices` and `refreshCryptoPrices`, a silent crypto refresh still toasts a failure, and toasts coins that came back with no price once per set of missing coins (`_cryptoMissingToasted`). Every manual caller passes no argument.

## Data layer

`freshDB()` returns the canonical empty DB shape. `ENTITY_SCHEMAS` defines per-table field types and validation. Conflict modal fires when a cloud write is attempted over a newer remote version. `kjr-core.js:looksPopulated()` guards against seeding a non-empty cloud sheet.

**Sync flow:** `pullFromRemote()` reconciles the Google Sheet on boot, `pushToRemote()` writes after a debounced local save. Apps Script `doGet` reads, `doPost` writes. `seedDecision()` (in kjr-core) prevents accidental overwrites on first run.

**Dashboard and saved charts:** Arrange orders the widgets `networth`, `overview` (Where it sits and Health), `activity` (Holdings and Today), `cpf` and `chart:<id>` in `DB.settings.dashLayout`. `_migrateDashLayout()` maps the pre-v2.70 ids (`assets`, `ef`, `targets`, `movers`) at read time and never writes on load. Saved charts carry `onDashboard`, with a read-time default of true except the seeded `def_alloc` and `def_networth` (since v2.71 the hero draws net worth itself). The dashboard draws only those, Explore lists every one. The hero chart reads `DB.snapshots` through `_heroSeries` (1M, 3M, YTD, 1Y, All), and the range choice is a per-device `localStorage` preference. Today's point is the live headline figure through `_heroWithLive`, display only, never stored. Where it sits always uses the CPF-inclusive total, because targets include CPF.

**Optional device encryption:** `kjr-vault.js` protects the local DB, price cache, Apps Script URL and `LK_DB_*` recovery snapshots. It keeps its derived key only in the unlocked tab, serialises writes through one authenticated encryption queue, and verifies ciphertext before deleting plaintext during migration. Boot must await the unlock gate before `loadLocal()`. Do not bypass `protectedStorage` for a sensitive key, and do not treat a locked vault as an empty first run.

## Key constants

- `APP_VERSION` and `APP_DISPLAY_VERSION`, bump together on every deploy, the display value is shown in the sidebar footer on desktop and in the More sheet on mobile
- `PHASE_2_TABS`, currently empty, tab keys placed here are hidden behind the Phase 2 gate
- `ENTITY_SCHEMAS`, field definitions used by CRUD helpers and validation

## Design tokens

Dark theme default (`--bg:#0B1120`, `--accent:#2dd4bf` teal). Warm light opt-in (`--bg:#F6F4EE`, `--accent:#0F6E56` deep teal). Base tokens: `--bg/bg2/bg3/bg4`, `--text/text2/text3`, `--red/green/blue/amber/purple`, `--radius/radius-lg`. Shell tokens: `--sidebar` (slightly darker than `--bg`) and `--sidebar-dim` for small text on it (light keeps `--text2`, because light `--text3` is only 4.55:1 on that surface). Light `--text2` is `#55514a` since v2.77 (7.17:1 on `--bg`, 4.5:1 or better on every light surface including `--bg4` and the grey More sheet) and light `--text3` is `#6f6a60` (4.89:1 on `--bg`, 4.23:1 on `--bg4`, where dim text takes `--text2`). Dark `--text3` is under 4.5:1 on `--bg3`, `--bg4` and a hovered table row, so those surfaces re-point `--text3` at `--text2`.

Glass layer (both themes): `--glass`, `--glass-strong`, `--glass-border`, `--glass-hi`, `--glass-blur`, `--glass-shadow`, `--surface-solid` (opaque backing for dense tables), `--glow1/--glow2`, `--tx/--tx2/--tx3` (text aliases). Since the v2.39 restyle, glass is reserved for floating elements only (topbar, modals, toasts, bottom tab bar, sync pill, currency and theme toggles). In-flow cards (`.card`, `.metric`, `.stat-box`, `.dash-hero`, `.h-summary`, `.bucket`, `.hint-block`, `.freshness`) are solid `--bg2` with a `--border` hairline and the `--shadow-card` token. Dense table cells and sticky columns use `--surface-solid`. `@supports not (backdrop-filter)` falls back to `--surface-solid` for the floating elements only.

## Files

- `index.html`, `sw.js` at the app root (runtime names, never rename)
- `Worker/` support sources (see Architecture), plus `manifest.webmanifest` and `whale-icon.png` for PWA install
- `tests/`, Node and browser unit tests. `npm test` from the app folder chains 14 scripts in this order: `test-core.js`, `test-app.js`, `test-apps-script.js`, `test-decision-notes-pilot.js`, `test-service-worker.js`, `test-vault.js`, `test-sortable.js`, `test-values.js`, `test-migration.js`, `test-supabase-schema.js`, `check-nas-config.js`, `test-nas.js`, `test-nas-app.js` and `check-release.js`. Then open `tests/tests.html` in a browser for the sortable suite
- `Docs/`, QA SOP and point-in-time docs. Feature backlog lives in `~/.assistant-control/tasks/todo.md`, never in a local file
- `../Trading/` and `../Forex/`, sibling apps with their own CLAUDE.md, cross-linked with relative paths
- Repo-root `CLAUDE.md` documents monorepo-wide commands and app boundaries, `AGENTS.md` is a symlink to it

## Journal Home glance (v2.85, reworked v2.86)

Settings has a Journal Home glance card with a Copy Journal glance button (`copyJournalGlance` in `Worker/app.js`, which copies through `_copyText`). It copies one short JSON summary to the clipboard, built by the pure `kjrBuildJournalGlance` in `Worker/kjr-core.js`: net worth EXCLUDING CPF, always (Julian 26/10/2026: the dashboard's Include CPF switch has no say and the payload says `exCpf: true`), the day P&L, and the largest mover (symbol, S$ move, percent). Day P&L and the mover cover open STOCKS only, crypto is left out of both. The net worth is `_allocationData(valuation.classes, false).total`, the dashboard headline with CPF off. Julian pastes it into a code block on a private page called `Home Glance Portfolio` in his own Journal, and Journal Home reads that page through his signed-in, owner-only session. The app makes no network call and holds no Journal credential, the summary reaches Journal only by that paste. Holdings, quantities, costs and accounts must never be added to it.

The shape is Journal's `lib/home/glance-contract.mjs` (schema `journal-home-glance/v1`, fail-closed, unknown fields rejected), so a change to either side needs the other updated. State rules: nothing held outside CPF (a CPF-only portfolio included) is `empty`. Assets that cannot be valued, such as a currency with no FX rate, are `incomplete`, never `empty`. A stock with no dated live quote (valued at cost, or a quote with no fetch time) and a coin valued at cost also make it `incomplete`. A complete summary whose oldest stock quote the app calls stale (over 24 hours, `isStale`) is `stale`, otherwise `ready`. `sourceUpdatedAt` and `asOf` are the fetch time of the oldest live stock quote used (never after the copy time), and the copy time only when no stock has a quote to date. The contract allows `stale` only when not incomplete, and Journal never ages an `incomplete` summary, so an incomplete one cannot also say stale. Journal turns a `ready` Portfolio summary stale 1 day after its `sourceUpdatedAt` (`STALE_AFTER_MS` in Journal's `lib/home/glance-page.js`, Julian 20/10/2026, it was 3 days).

## Gotchas

- `kjr-core.js` must stay side-effect-free. Any DOM or storage touch belongs in app code
- Apps Script must be re-deployed after every `.gs` change, Julian does this manually
- A key in `PHASE_2_TABS` hides that tab's UI while leaving its markup in the DOM. The set is empty today
- CSP `connect-src` restricts fetches to Apps Script only. New external fetches need a CSP update
- Service worker pre-cache URLs must match the `index.html` script tags exactly, including `?v=` query strings, or offline `caches.match` misses
- Sensitive browser keys use `protectedStorage`, not native `localStorage`. Web Crypto is asynchronous, so encrypted saves stay ordered through the vault queue and `beforeunload` warns while a save is pending
