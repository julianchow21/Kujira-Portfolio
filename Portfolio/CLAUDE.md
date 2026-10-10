# Kujira Portfolio

Personal net-worth tracker: SGX/US stocks, crypto, real estate, insurance, cash, CPF, salary, P&L, projections and a configurable watchlist. SGD base. Dual light/dark theme. PWA (Add to Home Screen). Deployed on GitHub Pages.

## Architecture

`index.html` at the app root, support sources in `Worker/`:

- `Worker/app.js`, the app logic
- `Worker/kjr-core.js`, pure, side-effect-free logic (no DOM, no localStorage, no fetch). Loaded as a `<script src>` global in the browser, also `require()`-able from `tests/` under node. **Keep pure.**
- `Worker/kjr-sortable.js`, drag-sort helper
- `Worker/kjr-vault.js`, optional passphrase-derived AES-GCM protection for sensitive browser storage
- `Worker/theme-init.js`, blocking theme init (FOUC guard)
- `Worker/apps-script.gs`, Google Apps Script backend deployed as a Web App. Handles `read`, `write`, `backup`, `restore`, `seed`, and `fundamentals` actions. Julian re-deploys manually at script.google.com after every `.gs` change.

Chart.js 4.4.1 (CDN, SRI-pinned). Backend is Google Apps Script + Google Sheets (no Supabase, no auth, no RLS).

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

**Mobile lists (v2.73):** at 640 px and below, Stocks, Crypto, Cash (accounts and ledger) and CPF history swap their tables for list rows built from the same row models in the same render pass (`_stockListModel`, `_cryptoListModel`, `_cashListModel`, `_cashTxnView`, `_cpfRowView`), so the list and the desktop table can never disagree. Filters become a scrolling chip row of native selects bound to the desktop state, and actions become one + Add plus a More menu (`MORE_MENU_ACTIONS` whitelist). Holding rows open through `openHoldingDetail(table, id)`. Desktop tables, sorting and Columns are unchanged.

**Holding panel and palette (v2.74):** `openHoldingDetail(table, id)` opens the holding side panel (`#holding-panel`, built by `_holdingPanelModel`, with a 3-month chart from `fetchStockHistory` using the key `THREE_MONTHS`, never the bare string `3mo`). ⌘K or Ctrl+K opens the command palette (`_paletteResults` is pure), and the shortcut stays blocked while the vault or NAS gate, any open overlay or the panel is up.

**Motion, privacy and Undo (v2.75):** `_reducedMotion()` gates every JS animation, and every CSS keyframe has a `prefers-reduced-motion` override. Hide amounts blurs amounts at 7 px. Percentage cells carry `.pct` and stay readable, so tag any new percentage cell the same way. The hero headline rolls between renders (`_heroShown`, `_heroRollPlan`), never on scrub. Refreshes snapshot `_priceCache` (`_priceSnapshot`, `_priceDiff`) and flash changed rows that carry `data-px`. Skeletons show only while a fetch is in flight and no visible holding has a price. Deleting a record that nothing references shows an Undo toast instead of a confirm. Cascading deletes, `cleanOrphanedTrades` and every irreversible or bulk action still confirm.

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

Dark theme default (`--bg:#0B1120`, `--accent:#2dd4bf` teal). Warm light opt-in (`--bg:#F6F4EE`, `--accent:#0F6E56` deep teal). Base tokens: `--bg/bg2/bg3/bg4`, `--text/text2/text3`, `--red/green/blue/amber/purple`, `--radius/radius-lg`. Shell tokens: `--sidebar` (slightly darker than `--bg`) and `--sidebar-dim` for small text on it (light uses `--text2`, because `--text3` misses 4.5:1 on that surface).

Glass layer (both themes): `--glass`, `--glass-strong`, `--glass-border`, `--glass-hi`, `--glass-blur`, `--glass-shadow`, `--surface-solid` (opaque backing for dense tables), `--glow1/--glow2`, `--tx/--tx2/--tx3` (text aliases). Since the v2.39 restyle, glass is reserved for floating elements only (topbar, modals, toasts, bottom tab bar, sync pill, currency and theme toggles). In-flow cards (`.card`, `.metric`, `.stat-box`, `.dash-hero`, `.h-summary`, `.bucket`, `.hint-block`, `.freshness`) are solid `--bg2` with a `--border` hairline and the `--shadow-card` token. Dense table cells and sticky columns use `--surface-solid`. `@supports not (backdrop-filter)` falls back to `--surface-solid` for the floating elements only.

## Files

- `index.html`, `sw.js` at the app root (runtime names, never rename)
- `Worker/` support sources (see Architecture), plus `manifest.webmanifest` and `whale-icon.png` for PWA install
- `tests/`, Node and browser unit tests. Run `npm test` from the app folder for `test-core.js`, `test-app.js` and `check-release.js`, then open `tests/tests.html` in a browser for the sortable suite
- `Docs/`, QA SOP and point-in-time docs. Feature backlog lives in `~/.assistant-control/tasks/todo.md`, never in a local file
- `../Trading/` and `../Forex/`, sibling apps with their own CLAUDE.md, cross-linked with relative paths
- Repo-root `CLAUDE.md` documents monorepo-wide commands and app boundaries, `AGENTS.md` is a symlink to it

## Gotchas

- `kjr-core.js` must stay side-effect-free. Any DOM or storage touch belongs in app code
- Apps Script must be re-deployed after every `.gs` change, Julian does this manually
- A key in `PHASE_2_TABS` hides that tab's UI while leaving its markup in the DOM. The set is empty today
- CSP `connect-src` restricts fetches to Apps Script only. New external fetches need a CSP update
- Service worker pre-cache URLs must match the `index.html` script tags exactly, including `?v=` query strings, or offline `caches.match` misses
- Sensitive browser keys use `protectedStorage`, not native `localStorage`. Web Crypto is asynchronous, so encrypted saves stay ordered through the vault queue and `beforeunload` warns while a save is pending
