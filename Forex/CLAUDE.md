# Kujira Forex

Multi-tenant SaaS trading journal (TraderSync-style). Phase 1 is single-user (Julian), architected to scale into multi-user plus Stripe billing with no rework. Full spec in `SPEC.md`. Sibling app in the Kujira/Portfolio repo, served at `/Forex/`.

## Architecture

Single-file SPA, all CSS/JS/HTML in `index.html`. No framework, no bundler. Built on App Starter: localStorage-first Supabase sync, preview guard, dirty-row tracking, light/dark theme, designed empty/error states, version badge. Shared engines vendored in `lib/` (`kjr-format.js`, `kjr-calendar.js`), configured not forked.

### Scale-ready seams (local owner or configured hosted account)

- `currentUser()` is the identity seam. When `config.js` resolves `mode:'offline'`, it returns the local owner (`{id:null}`). With complete hosted configuration and a verified Supabase session, it returns the authenticated user. The rest of the app must not identify users independently.
- `entitlement(feature)` is the paywall gate. It allows all features for the local owner and reads the authenticated hosted account state for other users. Every paid-only feature must call it.
- Local browser data is stored under the local-owner scope. Hosted rows are account-scoped by `auth.uid()`, and writes use the `sync_trade` RPC. `schema.sql` ships RLS-ready (option C). `lib/auth-client.js` supplies the verified bearer JWT for Supabase REST/RPC and Worker requests, so there is no manual `SB_HDR` swap.
- `profiles` owns the hosted plan and Stripe identity fields. Direct table writes are denied, and trusted billing RPCs are the mutation path.
- The free-trade cap does not apply to the local owner. Hosted free accounts enforce `FREE_TRADE_CAP` through the server RPCs.

### Hosted cutover checklist (before enabling hosted access)

- **Choose the database path.** For a fresh empty isolated Supabase test project, apply `schema.sql` directly and skip `migrations/phase2-user-id-backfill.sql`. For an existing cloud database, inspect `trades` first. Phase 1 cloud rows may have `user_id` NULL, and enabling the own-row policies before assigning ownership hides the journal. Run the backfill as the database owner only after confirming every NULL row belongs to one known `auth.users.id`.
- **Keep local data separate.** The owner’s existing browser data remains in its local scope. The schema backfill only assigns ownership to rows already in the cloud and does not import local browser data. Any move from local mode to a hosted account requires an explicit, reviewed export/import path.
- **Use the verified Auth transport.** Enable hosted mode only after `config.js` has valid public Supabase settings and the Auth client can verify a session. It supplies the JWT to REST, RPC and Worker calls; do not edit the unused legacy `SB_HDR` constant as a cutover step.
- **Server timestamps and CAS.** `sync_trade` receives the last `server_updated_at` token as `p_expected_updated_at`, locks and compares the row, and returns `applied`, `server_updated_at` and `server_deleted_at`. The `set_updated_at()` trigger stamps updates, and the client stores the returned server timestamp as the next CAS token. `Prefer: return=representation` is only the REST transport hint, not the version source.
- **Billing proof.** `profiles.stripe_customer_id` is server-bound through the trusted checkout and billing RPCs, not browser writes. Keep hosted billing disabled until test-mode customer binding, checkout attribution and webhook matching have all been verified.

### Data layer

Inherited from the starter, keep the gotchas true: preview guard at the TOP of the flush, snapshot dirty IDs before any await, localStorage-first and reconcile by timestamp (never by count), never sync a local preview, echo the server timestamp for concurrency, mobile CSS after base rules, no backdrop-filter on the topbar, derived values single-source.

### Config (top of `<script>`)

- `APP` — name, storageKey, version badge.
- `TABLES` — `['trades']` for now.
- Seams block — `currentUser`, `PLAN`, `ENTITLEMENTS`, `entitlement`, `FREE_TRADE_CAP`.
- `config.js` — public Supabase, Auth and Worker settings, disabled by default until a complete hosted configuration is supplied.

## Files

- `index.html` — the app.
- `schema.sql` — Supabase tables + RLS (trades, profiles).
- `sw.js`, `manifest.webmanifest`, `icon.svg` — PWA shell. Bump `CACHE` in `sw.js` on every ship: `CACHE` is `kjr-forex-v` + the `APP.version` badge number, bump it together with `APP.version` in `index.html`, enforced by `tests/check-release.js`.
- `lib/` — vendored shared engines.
- `SPEC.md` — product + tech spec (doubles as the PRD). Disposable once the build settles.

## Navigation shell

Shared with Portfolio and Trading (see the repo-root `CLAUDE.md`, Cross-app linkage). Above 768 px the sidebar holds the workspace menu, the views (Journal, Reports, Simulator, Coach, each through `showView()` so `authoriseFeature()` gating applies, with a "Locked" label when gated) and Tags. Its footer holds Account, Settings, the sync status in words, the theme toggle (`#theme-btn`) and the version (`#ver`). The top bar shows the view title and "+ Log trade". `#subnav` is the phone view switcher only. Tokens `--sidebar` and `--sidebar-dim` exist in both themes.

## Hosting

Static, GitHub Pages from the Kujira/Portfolio repo at `/Forex/`. Phase 2 adds a Cloudflare Worker for Stripe webhooks.

`frame-ancestors` only works as a response header, which GitHub Pages cannot send, so framing protection is not available on this host. Keep it out of the meta CSPs, browsers ignore it there and log a console error on every load.

## Build status

Phase 1 (single-user) is implemented, QA-verified and shipped as v0.13 on 29/08/2026. Phase 2 (multi-user authentication, cloud cutover and billing) remains deliberately disabled. Milestones M5 to M10 are tracked in `~/.assistant-control/tasks/todo.md`.
