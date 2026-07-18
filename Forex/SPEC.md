# Kujira Forex — Build Spec

v0.1 draft, 15 Jun 2026. Status: for review, no code written yet.

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

Out of scope (deliberately):
- 900+ broker auto-sync. Needs broker OAuth per vendor. Too much surface for a personal app.
- Tick-by-tick market replay. Needs a paid tick feed.
- Multi-user accounts beyond the single-owner Supabase row-level model already in use.

## 2. Architecture

- Sibling app in the existing repo: `Kujira/Portfolio/Forex/index.html`. Single-file SPA, no framework, no bundler, matching Trading and Portfolio.
- Scaffold via the `newproject` skill from the hardened web-app-starter template.
- Reuse the shared Kujira core (`kjr-core.js`) the Portfolio app already uses for Supabase auth and dirty-flag sync. Do not fork a second sync path.
- Charts via TradingView Lightweight Charts v5.2.0, the same version and global the Trading app loads.
- Dark theme only. Port the existing design tokens (`--bg*`, `--green`, `--red`, `--accent` #2dd4bf, `--blue`, `--amber`, `--radius`).
- Topbar segmented control becomes three-way: Trading | Forex | Portfolio. Update the same control in the Trading and Portfolio files so the set is consistent.
- Price data for chart markers reuses the Trading app's Worker proxy (`/chart`), not the public proxies.

## 3. Data model

One `trades` table in Supabase, mirrored to localStorage, synced with the existing dirty-flag and `mergeTable` logic. RLS on the table keyed to the owner, same pattern as Portfolio.

Trade record fields:

| Field | Type | Notes |
|---|---|---|
| id | uuid | client-generated |
| symbol | text | upper-cased |
| asset_type | enum | stock, option, future, forex, crypto |
| side | enum | long, short |
| status | enum | open, closed (derived from exit presence) |
| entry_at | timestamptz | stored in UTC, shown in SGT |
| exit_at | timestamptz | null while open |
| entry_price | numeric | |
| exit_price | numeric | null while open |
| quantity | numeric | shares or contracts |
| fees | numeric | commissions + fees |
| stop_price | numeric | planned stop, used for R-multiple |
| target_price | numeric | optional |
| setup_tags | text[] | |
| mistake_tags | text[] | |
| emotion_tags | text[] | |
| market_tags | text[] | trend, range, news, etc. |
| plan_note | text | written before/at entry |
| review_note | text | written after close |
| screenshots | text[] | optional, see section 4 phase 3 |
| created_at / updated_at | timestamptz | |
| dirty | bool (local only) | sync flag |

Derived values are never stored as columns. One `deriveTrade()` function computes gross P&L, net P&L, R-multiple, holding time, and return percent on read. This follows the standing rule that a derived value has a single source of truth and every view calls the same function.

Tags are stored inline as arrays on the trade. A small `tagCatalogue` in localStorage holds the master list per category plus a colour, so the manager can rename or recolour without touching every trade. Renames map old to new across trades in one pass.

## 4. Feature phases

Phase 1, MVP (the slice to build first):
- Add/edit/delete trade modal with validation.
- Trades table: sortable, filterable, paginated.
- Stats dashboard: the core metric cards plus the equity curve.
- Tags: setup, mistake, emotion, market. Multi-tag per trade. Tag manager.
- What-if simulator.

Phase 2:
- Entry/exit markers on the symbol's candlestick chart for a selected trade.
- Breakdowns: day-of-week, hour-of-day, by-symbol, by-tag, monthly calendar heatmap of P&L.
- Cumulative drawdown view.

Phase 3:
- CSV import with a column-mapping step (broker formats vary, so map once and remember the layout).
- AI coach: send the computed stat block and tag breakdowns (not raw trades) to Claude, return plain-English strengths, leaks, and one suggested focus.
- Screenshot attachments (decision needed, see open questions).
- Pre-trade plan and rule-compliance colouring against your own rules.

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

Open trades show unrealised P&L using the last price from the Worker proxy, kept separate from realised stats so they do not pollute the win rate.

## 6. The what-if simulator

The cheapest high-value feature. It is a predicate over the trade set fed back into the same stats engine.

- Controls: exclude trades carrying mistake tag X (multi-select), include only setup Y, restrict to chosen days or hours.
- On change, recompute the full metric set and the equity curve on the filtered subset.
- Render baseline versus simulated side by side, with the delta on each metric and both equity curves overlaid.
- Read-only. It never edits the underlying trades.

Example payoff: tag your impulse entries as `fomo`, exclude them, and see the equity curve and profit factor jump. That is the behaviour-change lever.

## 7. UI layout

- Dashboard: metric cards row, equity curve, recent trades, a "biggest leak" callout from the worst mistake tag by total loss.
- Trades: table with filter bar (symbol, date range, tags, side, status), sort, pagination, row click opens the trade.
- Trade detail/modal: all fields, tags, notes, and in phase 2 the chart with entry/exit markers.
- Simulator: the panel from section 6.
- Reports: the breakdowns from phase 2.
- Tag manager: list per category, rename, recolour, merge.

## 8. Data safety (standing bar, non-negotiable)

This app stores user data, so the full bar applies, unlike the read-only Trading dashboard.

- Input validation: required fields, exit after entry, positive quantity, numeric prices, sane fees.
- No silent data loss. The dirty flag is only cleared after a confirmed write. Honour the preview guard: bail at the top of the flush on localhost or file://, never clear dirty under the guard. (This is the exact loss class logged in lessons.)
- Conflict handling on sync: echo the server's own timestamp for optimistic concurrency, never compare two clocks. Reuse `mergeTable`.
- RLS on the `trades` table keyed to the owner.
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
8. Supabase sync via `kjr-core.js`, RLS, preview guard, conflict handling.
9. QA pass (the `qa` skill), then ship (the `ship` skill).
10. Phase 2 and 3 as separate efforts.

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

Direction changed: this is now a commercial multi-tenant SaaS, not a personal app. That raises it to the full enterprise bar (real per-user identity, RLS on every table, concurrency-safe writes, pagination).

Architecture additions on top of the journal core:
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

Once these land, the build plan goes into `~/Claude Projects/Claude/tasks/todo.md` for approval, then I scaffold from the hardened starter.

## 14. Build approach and product framing (added 15 Jun)

Decision: stabilise a single-user app for Julian first, but architect so multi-user and monetisation drop in without rework.

Product framing (this doubles as the PRD, no separate doc):
- Problem: traders track trades in spreadsheets that do not compute the real metrics or surface recurring leaks. Tools like TraderSync do, but are subscription-locked and broker-sync heavy.
- User: v1 is Julian, an active stock trader. Later, retail discretionary traders who want a clean journal without broker-sync lock-in.
- Core jobs: log a trade fast, see whether I am actually profitable, find my worst recurring mistake, test what my P&L would be without it.
- Success (v1): Julian logs his real trades and uses it weekly instead of a spreadsheet, and the metrics reconcile to his broker.
- Non-goals (v1): accounts, billing, landing page, broker auto-sync, tick replay.

Scale-ready seams (built from M0, no-op until Phase 2):
- `user_id` on every table (schema ships RLS option C). Swapping the anon key for a user JWT is a one-line change.
- one `entitlement(feature)` gate, returns true for everything now, reads `profiles.plan` later. Every paid-only feature calls it from day one.
- `currentUser()` abstraction, local owner now, Supabase Auth user later. No owner assumption scattered through the code.
- `profiles` table stubbed (plan, stripe_customer_id) so adding Stripe later only writes to it.

v1 release criteria (single-user "stable"):
- all trade CRUD validated (exit after entry, positive quantity, numeric prices)
- no silent data loss across reloads (dirty-flag + preview guard intact)
- stats reconcile against a known hand-checked trade set
- simulator output matches a manual recompute
- designed empty and error states, no blank boxes
- dark and light verified, mobile layout verified
- version badge live and matching
