# Kujira Portfolio

Personal net-worth tracker: SGX/US stocks, crypto (Phase 2), real estate, cash, CPF, salary, P&L, and projections (Phase 2). SGD base. Dual light/dark theme. PWA (Add to Home Screen). Deployed on GitHub Pages.

## Architecture

Single-file SPA (`index.html`) plus two extracted files:
- `kjr-core.js` — pure, side-effect-free logic (no DOM, no localStorage, no fetch). Loaded as a `<script src>` global in the browser; also `require()`-able from `tests/tests.html` under node. **Keep pure.**
- `apps-script.gs` — Google Apps Script backend. Deployed as a Web App via Google Drive. Handles `read`, `write`, `backup`, `restore`, `seed`, and `fundamentals` actions. Julian re-deploys manually after changes at script.google.com.

Chart.js 4.4.1 (CDN, SRI-pinned `sha384-9nhc…`).

## Tabs

| Tab | Key | Status |
|---|---|---|
| Dashboard | `dashboard` | Phase 2 locked (parked, code in DOM) |
| Stocks | `stocks` | Live |
| Crypto | `crypto` | Phase 2 locked |
| Real Estate | `realestate` | Live |
| Cash | `cash` | Live |
| CPF | `cpf` | Live |
| P&L | `cashflow` | Live |
| Projections | `projections` | Phase 2 locked |
| Settings | `settings` | Live |

To unblock a Phase 2 tab: remove its key from `PHASE_2_TABS`.

## Data layer

`freshDB()` returns the canonical empty DB shape. `ENTITY_SCHEMAS` defines per-table field types and validation. Conflict modal fires when a cloud write is attempted over a newer remote version. `kjr-core.js:looksPopulated()` guards against seeding a non-empty cloud sheet.

**Sync flow:** `loadFromSheets()` on boot, `syncToSheets()` on save. Apps Script `doGet` reads; `doPost` writes. `seedDecision()` (in kjr-core) prevents accidental overwrites on first run.

## Key constants

- `APP_VERSION` — bump on every deploy, shown in topbar badge
- `PHASE_2_TABS` — set of tab keys hidden behind the Phase 2 gate
- `ENTITY_SCHEMAS` — field definitions used by CRUD helpers and validation

## Design tokens

Warm light theme default (`--bg:#faf9f6`, `--accent:#c15f3c` terracotta). Dark opt-in (`--accent:#2dd4bf` teal). Base tokens: `--bg/bg2/bg3/bg4`, `--text/text2/text3`, `--red/green/blue/amber/purple`, `--radius/radius-lg`.

Glass layer (v1.7, both themes): `--glass`, `--glass-strong`, `--glass-border`, `--glass-hi`, `--glass-blur`, `--glass-shadow`, `--surface-solid` (opaque backing for dense tables), `--glow1/--glow2` (ambient radial glows), `--tx/--tx2/--tx3` (aliases for text tokens, fix latent bug). Surfaces use `--glass` + `backdrop-filter:blur(--glass-blur)`. Dense table `td/th` and sticky columns use `--surface-solid`. `@supports not (backdrop-filter)` fallback applies `--surface-solid` to all glass surfaces.

## Files

- `index.html` — main SPA (runtime name, never rename)
- `kjr-core.js` — pure logic, unit-tested (runtime name)
- `apps-script.gs` — Google Apps Script backend (runtime name)
- `sw.js`, `manifest.webmanifest`, `whale-icon.png` — PWA assets (runtime names)
- `tests/tests.html` — unit test runner, open locally
- `Docs/` — QA SOP (operational reference). Feature backlog lives in `~/Claude Projects/Claude/tasks/todo.md`, never in a local file
- `Backups/` — newest one snapshot per file, gitignored
- `../Trading/` — sibling app (MU day-trading dashboard), own CLAUDE.md. Cross-linked both ways with relative paths (`../Trading/`, `../Portfolio/`)
- `../index.html` + `../sw.js` (repo root) — redirect stub and sw kill switch from the pre-restructure root URL. Do not delete

## Gotchas

- `kjr-core.js` must stay side-effect-free. Any DOM or storage touch belongs in `index.html`.
- Apps Script must be **re-deployed** after every `.gs` change. Julian does this manually.
- `PHASE_2_TABS` hides the tab UI but the markup remains in the DOM, so the code is preserved.
- CSP `connect-src` restricts fetches to Apps Script only. New external fetches need a CSP update.
