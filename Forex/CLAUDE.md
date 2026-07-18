# Kujira Forex

Multi-tenant SaaS trading journal (TraderSync-style). Phase 1 is single-user (Julian), architected to scale into multi-user plus Stripe billing with no rework. Full spec in `SPEC.md`. Sibling app in the Kujira/Portfolio repo, served at `/Forex/`.

## Architecture

Single-file SPA, all CSS/JS/HTML in `index.html`. No framework, no bundler. Built on the hardened web-app-starter: localStorage-first Supabase sync, preview guard, dirty-row tracking, light/dark theme, designed empty/error states, version badge. Shared engines vendored in `lib/` (`kjr-format.js`, `kjr-calendar.js`), configured not forked.

### Scale-ready seams (single-user now, multi-user + billing later)

- `currentUser()` returns a local owner now (`{id:null}`). Phase 2 returns the Supabase Auth user. The only place the app asks "who is this".
- `entitlement(feature)` is the paywall gate. Returns true for everything while `PLAN==='owner'`. Phase 2 reads the plan from the `profiles` row and gates the paid features. Every paid-only feature must call it.
- Rows carry `user_id`, stamped in `sbBatchUpsert` when `currentUser().id` exists. `schema.sql` ships RLS-ready (option C). Phase 2 swaps the anon key for the user JWT in `SB_HDR` (one line, marked in the file).
- `profiles` table (plan, stripe_customer_id) stubbed in `schema.sql` so adding Stripe later only writes to it.
- `FREE_TRADE_CAP` constant present, unused while owner, enforced in Phase 2.

### Data layer

Inherited from the starter, keep the gotchas true: preview guard at the TOP of the flush, snapshot dirty IDs before any await, localStorage-first and reconcile by timestamp (never by count), never sync a local preview, echo the server timestamp for concurrency, mobile CSS after base rules, no backdrop-filter on the topbar, derived values single-source.

### Config (top of `<script>`)

- `APP` — name, storageKey, version badge.
- `TABLES` — `['trades']` for now.
- Seams block — `currentUser`, `PLAN`, `ENTITLEMENTS`, `entitlement`, `FREE_TRADE_CAP`.
- Supabase block — empty (runs fully local in Phase 1). Fill in to enable cloud.

## Files

- `index.html` — the app.
- `schema.sql` — Supabase tables + RLS (trades, profiles).
- `sw.js`, `manifest.webmanifest`, `icon.svg` — PWA shell. Bump `CACHE` in `sw.js` on every ship.
- `lib/` — vendored shared engines.
- `SPEC.md` — product + tech spec (doubles as the PRD). Disposable once the build settles.

## Topbar

Three-way segmented control: Trading | Forex | Portfolio, sibling links in the same repo.

## Hosting

Static, GitHub Pages from the Kujira/Portfolio repo at `/Forex/`. Phase 2 adds a Cloudflare Worker for Stripe webhooks.

## Build status

Phase 1 (single-user) in progress. Milestones M0 to M4 tracked in `~/Claude Projects/Claude/tasks/todo.md`.
