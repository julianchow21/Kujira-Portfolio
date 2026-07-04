# Kujira Portfolio

Personal net-worth tracker: SGX/US stocks, crypto (Phase 2), real estate, cash, CPF, salary, P&L, and projections (Phase 2). SGD base. Dual light/dark theme. PWA (Add to Home Screen). Deployed on GitHub Pages.

## Architecture

`index.html` at the app root, support sources in `Worker/`:

- `Worker/app.js`, the app logic
- `Worker/kjr-core.js`, pure, side-effect-free logic (no DOM, no localStorage, no fetch). Loaded as a `<script src>` global in the browser, also `require()`-able from `tests/` under node. **Keep pure.**
- `Worker/kjr-sortable.js`, drag-sort helper
- `Worker/theme-init.js`, blocking theme init (FOUC guard)
- `Worker/apps-script.gs`, Google Apps Script backend deployed as a Web App. Handles `read`, `write`, `backup`, `restore`, `seed`, and `fundamentals` actions. Julian re-deploys manually at script.google.com after every `.gs` change.

Chart.js 4.4.1 (CDN, SRI-pinned). Backend is Google Apps Script + Google Sheets (no Supabase, no auth, no RLS).

## Tabs

| Tab | Key | Status |
|---|---|---|
| Dashboard | `dashboard` | Phase 2 locked (parked, code in DOM) |
| Stocks | `stocks` | Live |
| Crypto | `crypto` | Live (v2.47, CoinGecko via Apps Script) |
| Real Estate | `realestate` | Live |
| Insurance | `insurance` | Live (merged from the standalone module, v2.43) |
| Cash | `cash` | Live |
| CPF | `cpf` | Live |
| P&L | `cashflow` | Live |
| Projections | `projections` | Live (v2.45, FIRE + CPF trajectory in today's dollars) |
| Settings | `settings` | Live |

To unblock a Phase 2 tab: remove its key from `PHASE_2_TABS`.

## Data layer

`freshDB()` returns the canonical empty DB shape. `ENTITY_SCHEMAS` defines per-table field types and validation. Conflict modal fires when a cloud write is attempted over a newer remote version. `kjr-core.js:looksPopulated()` guards against seeding a non-empty cloud sheet.

**Sync flow:** `loadFromSheets()` on boot, `syncToSheets()` on save. Apps Script `doGet` reads, `doPost` writes. `seedDecision()` (in kjr-core) prevents accidental overwrites on first run.

## Key constants

- `APP_VERSION`, bump on every deploy, shown in the topbar badge
- `PHASE_2_TABS`, tab keys hidden behind the Phase 2 gate
- `ENTITY_SCHEMAS`, field definitions used by CRUD helpers and validation

## Design tokens

Dark theme default (`--accent:#2dd4bf` teal). Warm light opt-in (`--bg:#faf9f6`, `--accent:#c15f3c` terracotta). Base tokens: `--bg/bg2/bg3/bg4`, `--text/text2/text3`, `--red/green/blue/amber/purple`, `--radius/radius-lg`.

Glass layer (both themes): `--glass`, `--glass-strong`, `--glass-border`, `--glass-hi`, `--glass-blur`, `--glass-shadow`, `--surface-solid` (opaque backing for dense tables), `--glow1/--glow2`, `--tx/--tx2/--tx3` (text aliases). Since the v2.39 restyle, glass is reserved for floating elements only (topbar, modals, toasts, bottom tab bar, sync pill, currency and theme toggles). In-flow cards (`.card`, `.metric`, `.stat-box`, `.dash-hero`, `.h-summary`, `.mover`, `.bucket`, `.hint-block`, `.freshness`) are solid `--bg2` with a `--border` hairline and the `--shadow-card` token. Dense table cells and sticky columns use `--surface-solid`. `@supports not (backdrop-filter)` falls back to `--surface-solid` for the floating elements only.

## Files

- `index.html`, `sw.js` at the app root (runtime names, never rename)
- `Worker/` support sources (see Architecture), plus `manifest.webmanifest` and `whale-icon.png` for PWA install
- `tests/`, node + browser unit tests (`node tests/test-core.js` from the app folder, `tests.html` in a browser)
- `Docs/`, QA SOP and point-in-time docs. Feature backlog lives in `~/Claude Projects/Claude/tasks/todo.md`, never in a local file
- `../Trading/` and `../Journal/`, sibling apps with their own CLAUDE.md, cross-linked with relative paths
- Repo-root `CLAUDE.md` documents monorepo-wide commands and app boundaries, `AGENTS.md` is a symlink to it

## Gotchas

- `kjr-core.js` must stay side-effect-free. Any DOM or storage touch belongs in app code
- Apps Script must be re-deployed after every `.gs` change, Julian does this manually
- `PHASE_2_TABS` hides the tab UI but the markup stays in the DOM, so the code is preserved
- CSP `connect-src` restricts fetches to Apps Script only. New external fetches need a CSP update
- Service worker pre-cache URLs must match the `index.html` script tags exactly, including `?v=` query strings, or offline `caches.match` misses
