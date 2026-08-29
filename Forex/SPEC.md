# Kujira Forex — Build Spec

v0.1 draft, 15 Jun 2026. Status updated 29/08/2026: the Phase 1 single-user feature set is implemented as a local-first app. Multi-user authentication, Supabase sync and billing are Phase 2 targets and remain disabled.

A personal trading journal and analytics app, modelled on TraderSync but trimmed to what one trader actually uses and what fits the Kujira single-file stack. You log each trade, tag it, and the app tells you what is working and what is losing money. It is retrospective. It does not replace the live Trading dashboard, it complements it.

## 1. Scope

In scope:
- Manual trade entry, edit, delete.
- Setup, mistake, and emotional tags.
- A full stats engine (metrics defined in section 5).
- Filters and breakdowns (by symbol, tag, day, hour, month).
- A what-if simulator (section 6).
- Entry/exit markers on a candlestick chart, reusing the Trading app's Yahoo plumbing.
- An AI coach that reads the computed stats and gives plain-English feedback (Claude API).
- CSV import.

Out of Phase 1 (deliberately):
- 900+ broker auto-sync. Needs broker OAuth per vendor. Too much surface for a personal app.
- Tick-by-tick market replay. Needs a paid tick feed.
- Multi-user accounts, billing and any paid launch. The seams exist in source, but no authenticated or paid runtime is live.

## 2. Architecture

- Sibling app in the existing repo at `Kujira/Portfolio/Forex/index.html`. It is a single-file SPA with no framework or bundler.
- Shared format and calendar engines are vendored in `lib/kjr-format.js` and `lib/kjr-calendar.js`. Forex owns its row-level local and dormant cloud-sync path in `index.html`, it does not import Portfolio's `kjr-core.js`.
- Phase 1 is localStorage-first. Supabase configuration is empty and `currentUser()` returns `{id:null}`, so cloud reads and writes do not run.
- `schema.sql` and row-level sync functions are Phase 2 preparation. They are not evidence that authentication, RLS cutover or cloud reconciliation is live.
- Charts load TradingView Lightweight Charts v5.2.0 lazily when requested.
- Dark and light themes are both implemented with a persisted toggle.
- The topbar is the live three-way control, Trading | Forex | Portfolio.
- Chart candles currently use a configurable CORS proxy whose default is `corsproxy.io`. They do not use the Trading Worker `/chart` route.

## 3. Data model

The Phase 1 source of truth is the `kjr_journal_v1` localStorage object, with one `trades` array. Dirty IDs and pending deletes are stored under separate local keys. The dormant Phase 2 Supabase schema wraps each trade as `id`, `data`, `updated_at`, `deleted_at` and `user_id`. No Phase 1 row has an authenticated `user_id`.

Trade record fields:

| Field | Type | Notes |
|:---|:---:|:---|
| `id` | text | Client-generated, validated to 1 to 64 letters, numbers, underscores or hyphens |
| `symbol` | text | Upper-cased |
| `side` | enum | `long` or `short` |
| `entryAt` | ISO timestamp | Stored in UTC |
| `exitAt` | ISO timestamp or empty | Empty while open |
| `entryPrice` | number | Positive |
| `exitPrice` | number or empty | Required with `exitAt` to close a trade |
| `quantity` | number | Positive shares or contracts |
| `fees` | number | Non-negative commissions and fees |
| `stopPrice` | number or empty | Planned stop, used for R-multiple |
| `setupTags`, `mistakeTags`, `emotionTags`, `marketTags` | text arrays | Stored inline on the trade |
| `notes` | text | Combined setup, context and review notes |
| `contractMultiplier` | number | Defaults to 1 |
| `createdAt`, `updatedAt` | ISO timestamps | Client record timestamps |
| `_updatedAt`, `_deletedAt` | ISO timestamps or empty | Dormant Phase 2 server revision and tombstone metadata |

Derived values are never stored as columns. One `deriveTrade()` function computes gross P&L, net P&L, R-multiple, holding time, and return percent on read. This follows the standing rule that a derived value has a single source of truth and every view calls the same function.

Tags are stored inline as arrays on the trade. The manager derives its catalogue from those arrays. Rename, merge and delete operations update every affected trade, mark each row dirty and retain one local undo snapshot for tag deletion.

## 4. Feature phases

Current Phase 1, single-user local delivery:
- Add, edit and delete trade modal with validation
- Sortable, filterable and paginated journal
- Stats dashboard, equity curve, reports and cumulative drawdown
- Setup, mistake, emotion and market tags, including the tag manager
- What-if simulator
- On-demand entry and exit chart markers
- CSV import
- AI coach using a browser-stored Anthropic key for personal use only
- Persisted dark and light themes

Phase 2 platform cutover, dormant:
- Supabase Auth and a real `currentUser()` identity
- User JWT requests, `user_id` backfill and RLS enablement
- Server-backed row-level compare-and-swap sync and paginated reconciliation
- Profiles, enforced entitlements, billing and a server-side AI proxy

Additional product work:
- Screenshot attachments
- Pre-trade plan and rule-compliance colouring
- Broker auto-sync or paid market replay only if their external dependencies are accepted

## 5. Metrics catalogue

Computed over the current filter set, closed trades only unless noted.

- Net P&L: sum of net P&L. Net = (exit − entry) × qty × sideSign − fees.
- Win rate: wins / closed trades. A win is net P&L > 0.
- Average win, average loss: mean net P&L of winners, of losers.
- Payoff ratio: average win / average loss (absolute).
- Profit factor: gross profit / gross loss (absolute). Above 1 is profitable.
- Expectancy (currency): mean net P&L per trade.
- Expectancy (R): mean R-multiple, where R-multiple = net P&L / initial risk, and initial risk = |entry − stop| × qty. Trades without a stop are excluded from R stats and flagged.
- Max drawdown: largest peak-to-trough fall on the cumulative net P&L curve.
- Largest win, largest loss.
- Average holding time: mean of (exit_at − entry_at).
- Return per share/contract: net P&L / total quantity.
- Trade count, win/loss/breakeven counts, open-position count.

Open trades are counted separately and do not affect realised win-rate statistics. Current source does not fetch a live price for unrealised P&L. The candle proxy is used only for the on-demand chart.

## 6. The what-if simulator

The cheapest high-value feature. It is a predicate over the trade set fed back into the same stats engine.

- Controls: exclude selected mistake tags, include only selected setup tags, and restrict by long or short side.
- On change, recompute the full metric set and the equity curve on the filtered subset.
- Render baseline versus simulated side by side, with the delta on each metric and both equity curves overlaid.
- Read-only. It never edits the underlying trades.

Example payoff: tag your impulse entries as `fomo`, exclude them, and see the equity curve and profit factor jump. That is the behaviour-change lever.

## 7. UI layout

- Dashboard: metric cards row, equity curve, recent trades, a "biggest leak" callout from the worst mistake tag by total loss.
- Trades: table with symbol search, status filter, sortable columns, pagination and row click to edit.
- Trade detail/modal: all current fields, tags, notes and an on-demand chart with entry/exit markers.
- Simulator: the panel from section 6.
- Reports: day, hour, symbol, tag, monthly P&L and drawdown breakdowns.
- Tag manager: list per category, rename, merge, delete and one-step undo for deletion.

## 8. Data safety (standing bar, non-negotiable)

This app stores user data, so the full bar applies, unlike the read-only Trading dashboard.

- Input validation: required fields, exit after entry, positive quantity, numeric prices, sane fees.
- No silent data loss. The dirty flag is only cleared after a confirmed write. Honour the preview guard: bail at the top of the flush on localhost or file://, never clear dirty under the guard. (This is the exact loss class logged in lessons.)
- Conflict handling on sync: echo the server's own timestamp for optimistic concurrency, never compare two clocks. Reuse `mergeTable`.
- Phase 2 only: RLS on `trades` keyed to the authenticated user. Phase 1 is fully local and must not be described as RLS-protected.
- Pagination on the trades list from day one.
- Designed empty states (no trades yet) and error states (sync failed, proxy down).
- Backups: snapshot before any destructive bulk action (tag merge, CSV import overwrite), before the action runs, not after.

## 9. Build order

1. Scaffold `Forex/` from the starter, wire the three-way topbar, port tokens.
2. Trade data model + localStorage + `deriveTrade()`.
3. Add/edit/delete modal with validation.
4. Trades table with filters, sort, pagination.
5. Stats engine + dashboard cards + equity curve.
6. Tags + tag manager.
7. Simulator.
8. Keep the dormant row-level Supabase client and `schema.sql` aligned, without enabling cloud sync in Phase 1.
9. QA pass (the `qa` skill), then ship (the `ship` skill).
10. Activate authentication, RLS, cloud sync and billing only through the Phase 2 cutover checklist in `CLAUDE.md`.

## 10. Open questions for Julian

These shape the schema, so worth settling before the build starts.

1. Which asset types first? Stocks only for the MVP, or options/futures/forex/crypto from the start? Options and futures need contract multipliers in the P&L maths.
2. Base currency: SGD, USD, or per-trade currency with conversion?
3. Seed data: import your existing trades from the Investment Tracker, or start the journal empty?
4. Screenshots: store as base64 in Supabase (simple, but heavy rows), use Supabase Storage (cleaner, more wiring), or skip for now?
5. Emotional tags: keep them, or is that more ceremony than you will use?

## 11. Effort and phasing (added 15 Jun)

"Build days" means focused build-and-verify effort. Elapsed time runs longer and depends on review cadence.

Buildable journal set, to the personal-use bar:

| Group | Build days |
|---|---|
| Phase 1: entry, stats engine, tags, filters, simulator, sync, QA, ship | 2 to 4 |
| Chart entry/exit markers (reuses Trading plumbing) | 1 to 2 |
| Breakdowns + calendar heatmap + drawdown | 2 to 3 |
| Evaluator (multi-variable compare) | 1 to 2 |
| Custom dashboard widgets | 1 to 2 |
| CSV import with column mapping | 2 to 3 |
| AI coach (Claude API over stats) | 1 to 2 |
| Screenshots + pre-trade plan + rule compliance | 2 to 3 |
| Options/futures multipliers | 1 to 2 |

Subtotal: roughly 13 to 23 build days (about two to three weeks elapsed for personal use).

Not a time estimate, bounded by external dependencies:
- 900+ broker auto-sync: a per-broker API and partnership problem. Realistic substitute is one paid aggregator (SnapTrade or similar) covering the brokers you use: 3 to 5 days plus an ongoing fee. CSV import covers everyone for free.
- Tick-by-tick market replay: blocked on a paid tick/depth/time-and-sales feed (cost, not time). A candle-replay cut-down is 2 to 3 days.

## 12. Monetisation and multi-tenant pivot (added 15 Jun)

The Phase 2 target is a commercial multi-tenant SaaS. The current Phase 1 app remains a single-user local build. A sellable release therefore requires real per-user identity, RLS on every table, concurrency-safe writes, pagination and server-enforced billing before it can be called multi-tenant.

Phase 2 architecture targets, not active runtime claims:
- Supabase Auth (email plus OAuth) for real identity. Every table keyed to `auth.uid()` with RLS. No single-owner shortcut.
- A `profiles` row per user holding plan/entitlement and the Stripe (or MoR) customer id.
- Billing: Checkout plus a customer/billing portal, plus a Cloudflare Worker webhook that updates the plan on subscription events. Plan status is the single source of truth for entitlements.
- Feature gating: an `entitlements` map per plan. The client locks gated features for UX, the server enforces limits and paid-data access. Never trust the client for the paywall.
- Marketing landing page plus a pricing page and sign-up funnel.
- Legal: Terms, refund policy, and the existing PRIVACY/SECURITY docs adapted for paying users.

SaaS-foundation effort, on top of the journal features:

| Group | Build days |
|---|---|
| Auth + multi-tenant RLS + profiles | 2 to 4 |
| Stripe/MoR Checkout + portal + Worker webhook + plan sync | 3 to 5 |
| Entitlements/feature-gating layer | 1 to 2 |
| Landing + pricing + sign-up funnel | 2 to 4 |
| Account/billing settings (manage, cancel, history) | 1 to 2 |

Subtotal: roughly 9 to 17 build days.

Honest combined range:
- A sellable v1 (journal Phase 1 + simulator + a few paid-only analytics + auth + billing + landing): about 4 to 6 weeks elapsed.
- Full TraderSync-equivalent feature set plus the SaaS layer (still excluding broker auto-sync and tick replay): about 8 to 12 weeks elapsed.

Real-world dependency, not code: you need a Stripe or Merchant-of-Record account and a business entity that can receive payouts. Set that up in parallel. It gates going live, not the build.

## 13. Decisions being confirmed (gates the foundation)

Confirmed 15 Jun:
1. Pricing model: freemium subscription. Free tier with limits, paid monthly/annual tiers unlock the rest.
2. Payment processor: Stripe.
3. Paywall split: free logging plus basic stats, capped (target 50 trades). Paid unlocks unlimited trades plus the simulator, advanced analytics, AI coach, chart markers, and CSV import.

These decisions are represented by dormant seams in the current source. They do not make authentication, billing or paid entitlements live.

## 14. Build approach and product framing (added 15 Jun)

Decision: stabilise a single-user app for Julian first, but architect so multi-user and monetisation drop in without rework.

Product framing (this doubles as the PRD, no separate doc):
- Problem: traders track trades in spreadsheets that do not compute the real metrics or surface recurring leaks. Tools like TraderSync do, but are subscription-locked and broker-sync heavy.
- User: v1 is Julian, an active stock trader. Later, retail discretionary traders who want a clean journal without broker-sync lock-in.
- Core jobs: log a trade fast, see whether I am actually profitable, find my worst recurring mistake, test what my P&L would be without it.
- Success (v1): Julian logs his real trades and uses it weekly instead of a spreadsheet, and the metrics reconcile to his broker.
- Non-goals (v1): accounts, billing, landing page, broker auto-sync, tick replay.

Scale-ready seams (built from M0, no-op until Phase 2):
- `schema.sql` includes `user_id`, RLS policies and a row-level compare-and-swap RPC. Phase 1 stays local, so no authenticated `user_id` exists yet. Any old cloud rows must be backfilled before RLS is enabled.
- `entitlement(feature)` returns true for the owner today. Phase 2 must read the authenticated user's plan and enforce paid limits on the server as well as in the client.
- `currentUser()` returns the local owner with `id:null` today. Phase 2 must return the Supabase Auth user and send that user's JWT in `SB_HDR`.
- `profiles` is stubbed with `plan` and `stripe_customer_id`. No current flow populates the Stripe customer ID, so billing is not ready to take money.

v1 release criteria (single-user "stable"):
- all trade CRUD validated (exit after entry, positive quantity, numeric prices)
- no silent data loss across reloads (dirty-flag + preview guard intact)
- stats reconcile against a known hand-checked trade set
- simulator output matches a manual recompute
- designed empty and error states, no blank boxes
- dark and light verified, mobile layout verified
- version badge live and matching
