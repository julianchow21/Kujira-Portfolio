# Portfolio monorepo

Monorepo of 4 static SPAs hosted on GitHub Pages. No framework, no bundler, no build step. Open any `.html` directly or serve from repo root.

> Master rules also apply from `~/Claude Projects/Claude/CLAUDE.md` (Julian's identity, formatting, workflow, skills, GitHub push, file naming, folder cleanliness, version badge, UI quality standard). That file loads separately and is not duplicated here. This file covers repo-specific architecture, commands, constraints, and gotchas no agent could infer from filenames alone.

## Commands

- **Dev server:** `npx serve -l 3807 .` (launch config: `kjr-portfolio` in `.claude/launch.json`)
- **Node unit tests (core logic):** `node Portfolio/tests/test-core.js`
- **Release consistency check:** `node Portfolio/tests/check-release.js`, run before every ship. Asserts index.html script tags match sw.js CORE_ASSETS exactly (including `?v=` strings), sw.js CACHE_NAME equals `kjr-portfolio-` + APP_VERSION, and APP_VERSION agrees with APP_DISPLAY_VERSION
- **Browser unit tests (sortable):** open `Portfolio/tests/tests.html` in a browser
- `Portfolio/package.json` "test" script now runs test-core.js then check-release.js (`npm test` from `Portfolio/`). The old broken stub is gone.
- No lint/typecheck/format scripts. `Portfolio/.eslintrc.json` exists but is not wired to any command.

## App boundaries

| App | Entrypoint | Key sources | Backend |
|-----|-----------|-------------|---------|
| **Portfolio/** | `index.html` | `Worker/app.js` (app logic), `Worker/kjr-core.js` (pure), `Worker/kjr-sortable.js` (drag sort) | Google Apps Script (`Worker/apps-script.gs`) |
| **Trading/** | `index.html` (all in one) | - | Cloudflare Worker (`Trading/Worker/`) for Yahoo proxy |
| **Journal/** | `index.html` (all in one) | `lib/kjr-format.js`, `lib/kjr-calendar.js` (vendored shared engines), `schema.sql` (Supabase) | Supabase (Phase 2) |
| **Insurance Module/** | `index.html` | - | None (prototype) |

Every app has its own `CLAUDE.md` with architecture notes, gotchas, and design tokens. **Read the app's CLAUDE.md before modifying it.**

## Cross-app linkage

All apps share a topbar with a three-way segmented control linking `Trading`, `Journal`, and `Portfolio` via relative paths (`../Trading/`, `../Journal/`, `../Portfolio/`). If you change topbar layout, update all three.

## Critical constraints

### kjr-core.js purity (Portfolio)
- **NEVER add DOM, localStorage, fetch, or any browser API call** to `Portfolio/Worker/kjr-core.js`.
- It is loaded as a global `<script src>` in `index.html` AND `require()`-d by Node tests. Side effects break either path.
- All app logic that touches the browser goes in `Worker/app.js` or `index.html`.

### apps-script.gs deployment (Portfolio)
- After **every** change to `Portfolio/Worker/apps-script.gs`, the Apps Script must be **re-deployed manually** at script.google.com (Deploy, Manage deployments, pencil, New version, Deploy).
- Skipping this step silently ships stale backend code.

### CSP (Portfolio)
- `index.html` meta CSP restricts `connect-src` to `script.google.com` and subdomains. Any new external fetch (new API, new CDN) needs a CSP update in `index.html:11`.

### kjrEscape for innerHTML (all data-storing apps)
- Every `innerHTML` interpolation of user or sheet data must use `kjrEscape`. Audit with: `grep -nE 'onclick="[^"]*\${' index.html`. Consult `SECURITY.md` audit checklist.

### Static HTML audit before release (SECURITY.md)
- SRI: Chart.js `<script>` tag must have `integrity` and `crossorigin="anonymous"`.
- No hardcoded Apps Script URL (`grep -i 'AKfycb' index.html` returns nothing).
- CSP meta tag present and match against live URL.

## Data safety rules (Portfolio & Journal)

These are hard-learned loss classes; every data-storing app must uphold them:

1. **Preview guard at the TOP of the flush.** Bail immediately on `localhost` or `file://`. Never clear dirty flags under the guard.
2. **Snapshot dirty-row IDs before any `await`.** Do not re-derive mid-sync; an in-flight user edit will drop rows.
3. **Sync by timestamp (server's), never by count.** Echo the server's own timestamp for optimistic concurrency.
4. **Never sync a local preview.** They carry fake timestamps and will overwrite real data.
5. **Backup before destructive bulk actions** (tag merge, CSV import overwrite), before the action runs.

## Portfolio app specifics

- `APP_VERSION` and `APP_DISPLAY_VERSION` live in `Portfolio/Worker/app.js:14-15`. Bump both on every deploy.
- `PHASE_2_TABS` hides locked tabs from the nav but their DOM markup remains intact; code is preserved, not deleted.
- Portfolio uses warm light theme **default** with dark opt-in. Trading and Journal use dark only. Don't apply one app's theme default to another.

## Trading app specifics

- `fitContent()` must be called inside `requestAnimationFrame` after `setData`, or it fits against the previous timeframe's layout.
- Multi-day intraday axis: check `tickMarkType`. `<=2` (Year/Month/DayOfMonth) shows date; `>=3` (Time) shows clock. Crosshair also shows date+time.
- `.topbar` has `z-index:100`; settings drawer is `z-index:201`.
- Trading's current price, header, and indicators are always driven by the 1m session (`lastCore`). The timeframe selector only changes the chart (`lastChart`). Do not wire header or alerts to `curTf`.
- Prefer `onclick =` over `addEventListener` for idempotent handler assignment (fixes listener stacking from `renderToggles` re-entrancy).

## Journal app specifics

- `currentUser()` is the only place that asks "who is this". It returns local owner now, Supabase Auth user in Phase 2.
- `entitlement(feature)` is the paywall gate. It returns `true` for everything while single-user. Every paid-only feature must call it.
- `user_id` on every table row, stamped in `sbBatchUpsert`. Phase 2 swaps anon key for user JWT (one line, marked in the file).
- `lib/kjr-format.js` and `lib/kjr-calendar.js` are vendored shared engines; configured, not forked.

## Insurance Module

- Prototype only. Single `index.html`, no backend, no tests. Reuses Portfolio's light-theme design tokens.

## Repo-specific workflow rules

These extend or override the master `CLAUDE.md` rules for this repo.

### Folder cleanliness

- **No Backups/ folders.** Master rules forbid backup snapshots. If `Backups/` directories appear in this repo, delete them to Trash. Git history is the archive.
- **Point-in-time docs are disposable.** QA reports, gap reviews, and implementation specs get this footer when created: `*Disposable point-in-time doc. Delete once fully actioned (see CLAUDE.md).*` Delete them once actioned. Living docs (runbooks, SOPs, CLAUDE.md, AGENTS.md) stay.
- **Superseded Worker versions.** When vN+1 of a script or worker lands, delete vN.

### File naming

- Name every new file with a proper Title Case name, a version, and a short date in brackets: `Allocated Dog v1 (25 May).ext`.
- **Runtime files keep their exact name**, never rename them: `index.html`, `sw.js`, `manifest.webmanifest`, `whale-icon.png`, `kjr-core.js`, `apps-script.gs`, `CLAUDE.md`.

### Version badge

- Bump the version badge on every deploy. Each app has its own: Portfolio (`APP_DISPLAY_VERSION` in `Worker/app.js:15`), Trading (inline in `index.html`), Journal (inline in `index.html`). Match the badge version to the commit message version.

### GitHub push

- Confirm once per session, then push freely. Direct to `main`, no feature branches.
- Commit message format: `Portfolio v1.5 fix mobile sell grid overflow` (sub-project name + version + imperative description).
- End every commit with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

### Verify before done

- Open `.html` files in browser, check golden path plus edge cases. Cache-bust JS/CSS includes with `?v=<timestamp>` before verifying. Check browser console for zero errors.

## Files you should know about

- **Feature backlog:** `~/Claude Projects/Claude/tasks/todo.md` (external path, **never** in a local file)
- Each app's `CLAUDE.md` (architecture, tabs, data layer, gotchas, design tokens)
- `Portfolio/Docs/QA SOP v1 (4 Jun).md` (QA runbook, seed data instructions, invariants)
- `SECURITY.md` (threat model, audit checklist; run before each release)
- `README.md` (user-facing setup walkthrough)
- `.claude/` and `.wrangler/` are **gitignored**; don't rely on them being committed

## Conventions

- All apps use the Kujira design token system: `--bg/bg2/bg3/bg4`, `--text/text2/text3`, `--red/green/blue/amber`, `--accent`, `--radius`, `--glass*` (Portfolio), `--surface-solid` (Portfolio dense tables)
- Portfolio light theme default (`--accent:#c15f3c` terracotta); dark override (`--accent:#2dd4bf` teal). Trading/Journal: dark only, `--accent:#2dd4bf`.
