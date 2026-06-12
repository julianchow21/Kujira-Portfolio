# MU Day Trading Dashboard, production gap review (11 Jun)

## Context

Julian asked for a full review of `~/Claude Projects/Kujira/Portfolio/Trading/index.html` (1,103 lines, single-file SPA): understand the concept, compare it against production-grade financial and day-trading platforms, and produce findings a Sonnet session can execute. This file is the report and the execution backlog. Read the project `CLAUDE.md` before touching code, it documents the architecture and the gotchas that already bit us once.

## The concept as built

A zero-cost, single-ticker day-trading cockpit. One Yahoo v8 chart call per refresh feeds everything: hero readout (price, change, OHLC stats, volume), candlestick chart with 1m/5m/15m/1h/1D timeframes, session indicator cards (VWAP, EMA 9/20, RSI 14, MACD), and edge-triggered alerts (price, RSI, VWAP cross, EMA cross) with toast, beep, and browser notification. Market clock is ET DST-aware, refresh is 15s when open, slower otherwise, paused when hidden. Data path is a configurable proxy (public proxies as trial, Cloudflare Worker as the chosen real path, Apps Script as fallback). Since the 04/06 session someone added `?symbol=` URL-param support, so it is now quietly multi-ticker.

**Architecture invariant to preserve (from CLAUDE.md):** header, indicator cards, and alerts always run off today's 1m session (`lastCore`, `CORE_PARAMS`). The timeframe selector only changes the chart (`lastChart` via `loadChart()`). Do not wire header or alerts to `curTf`.

## Where it stands vs production

Compared against TradingView (free tier), broker apps Julian's "confirm with broker" loop would use in SG (moomoo, Webull, Tiger), and pro day-trading tools (Thinkorswim, DAS Trader, Trade-Ideas, Bookmap).

| Capability | This app | Production | Verdict |
|---|---|---|---|
| Price + chart + standard indicators | Yes, clean | Yes | At parity for the basics |
| Data feed | 15s polled Yahoo bars, no bid/ask | Streaming ticks, bid/ask, L2 | Structural gap, partly closable free |
| Key levels (prev day H/L/C, premarket H/L, opening range) | Missing | Core of every day-trading layout | Biggest decision-value gap, data already fetched |
| Relative volume (RVOL), gap %, ATR | Missing | Standard scanner columns | Cheap to compute from existing data |
| Position sizing / risk tools | Missing | Standard | Pure client maths, high value |
| Alerts | Good engine, but only while tab open and visible | Server-side, push to phone | Biggest practical gap for SGT market hours (21:30 to 04:00) |
| Drawing tools / levels on chart | None | Trend lines, alert-on-line | Partial parity cheap via price lines |
| Indicator panes (RSI/MACD subcharts) | Cards only | Panes under chart | Medium value, needs Lightweight Charts v5 |
| News, earnings calendar, halts, L2, time and sales | None | Yes | Mostly needs paid data, defer or link out |
| Trade execution | None by design | Yes | Keep read-only, this is deliberate |

The app's niche is right: a focused, instant-loading, no-login cockpit for one name. The plan is not platform parity, it is closing the gaps that speed up Julian's actual decision loop: levels, participation (RVOL), sizing, and alerts that still work when the phone screen is off.

## Execution backlog for Sonnet

### Phase 0, correctness and housekeeping (do first, small)

1. **Alert namespacing bug.** localStorage keys are global (`mu_cfg`, `mu_alerts`, `mu_alertlog` at line ~355) but `?symbol=` now exists, so MU alerts will evaluate against another ticker's prices. Key alerts and log by symbol (e.g. `mu_alerts_<SYMBOL>`), keep cfg global, migrate existing keys on first load
2. **Notification title hardcodes "MU"** in `fireAlert()` (line ~844), use `SYMBOL`
3. **`encodeURIComponent(SYMBOL)`** in `yahooTarget()` and `requestUrls()`, the param is user-controlled via URL
4. **Failure backoff.** `scheduleNext()` repolls at full rate even when every proxy is failing. Add exponential backoff after consecutive failures (15s, 30s, 60s, cap 5m) with reset on success, mirroring the Kujira hard-block lesson
5. **Boot cache.** Persist last good core payload to localStorage, paint it instantly on load with the stale pill shown, then refresh live. Kills the blank "—" cold start
6. **Version badge** (binding CLAUDE.md rule, currently missing). Add `v2.0 (11 Jun)` badge in the footer, bump on every deployed change
7. **Stale copy**: settings hint "Show extended-hours bars on the 1D chart" should say "on intraday timeframes"
8. **TTL cache per timeframe.** When `curTf` is not 1m, every 15s refresh refetches the chart series whose bars change at most every 5 to 15 minutes. Cache by interval with a sensible TTL (5m TF: 60s, 15m: 5min, 1h: 15min, 1D: 1h)

### Phase 1, decision-value features (the real upgrade)

9. **Key levels engine + card + chart lines.** Compute from data already fetched: prev day high/low/close, today's open, premarket high/low (needs `includePrePost=true` on the core fetch regardless of the extended-hours chart toggle, compute from pre-session bars), opening range high/low (first 15 and 30 min). Render as `createPriceLine()` lines on the chart (distinct muted colours plus labels, never colour alone) and a "Levels" card listing each with distance from current price. Each level gets a one-tap "alert me" button that creates a price alert at that level
10. **RVOL stat.** Cumulative volume today vs average cumulative volume at the same time of day over the last 10 sessions (compute from the 5d/5m series, upgrade the fetch to 1mo/5m if needed). Show in the header stat grid with a chip (e.g. above 1.5 = "Active", below 0.7 = "Thin"). This is the single best "is this move real" signal day traders use
11. **Gap % and % from open** stats in the header grid (open vs prev close, price vs open)
12. **ATR card.** Daily ATR(14) from the 1D series plus today's range as % of ATR ("used 80% of ATR"). Sets stop distances and tells Julian when the day is exhausted
13. **Position size calculator card.** Inputs: account risk (S$ or %), entry, stop. Output: shares, position value, R-multiple targets (1R, 2R) with prices. Persist inputs in cfg. Pure client-side, no data needed
14. **Countdown to close** in the market pill when open ("Open · closes in 1h 23m"), production-standard, trivial via the existing clock helpers
15. **Live tab title** `document.title = SYMBOL + " 1079.57 ▲1.4%"` on each core refresh, and tint the favicon teal/green/red by day direction (regenerate the existing inline SVG)
16. **US market holiday list.** Static 2026 NYSE holiday + half-day array in the market clock so the pill stops claiming the market opens on a holiday. Known limitation documented in CLAUDE.md, fix it properly

### Phase 2, alert engine parity

17. **Crossing semantics.** VWAP/EMA cross alerts currently fire if the condition is already true when armed. Track previous condition state, fire only on false to true transition. Keep level alerts (price above/below) as-is, that is the expected behaviour for those
18. **Per-alert options**: one-shot vs re-arming (currently always re-arms), optional cooldown minutes. Small additions to the alert object and `evaluateAlerts()`
19. **Server-side alerts via the Worker (the big one).** The dashboard only alerts while the tab is open and visible, useless when the phone is locked at 2am SGT. Extend the deployed Cloudflare Worker with a cron trigger (free tier supports them): store Julian's levels in Worker KV (synced from the dashboard via a small POST endpoint), check MU each minute during market hours, push to Telegram via a bot token stored as a Worker secret. The dashboard gets a "Push alerts to Telegram" section in Settings. This is optional scope, it is the largest single jump toward production behaviour, build it as its own work item with its own plan

### Phase 3, chart power (optional, behind the above)

20. **Tap-to-place horizontal levels** on the chart (click → confirm price → price line + auto-created alert), unifying levels and alerts the way TradingView does. Lightweight Charts gives click coordinates and `coordinateToPrice()`
21. **VWAP standard-deviation bands** (±1σ, ±2σ) as faint lines, computed in the same `vwapSeries()` pass
22. **Relative strength vs SMH or SPY**: second symbol fetched through the same proxy, plotted as a normalised % line or shown as an RS stat ("MU +1.4% vs SMH +0.2%"). Day traders trade MU with or against the semi tape
23. **Indicator panes** (RSI and MACD under the main chart) require Lightweight Charts v5 (native panes, v4.2 has none). Treat the v5 upgrade as its own task with regression checks on the fit-after-setData and tick-formatter gotchas in CLAUDE.md

### Deferred, with reasons (state these to Julian, do not silently drop)

- Bid/ask spread, L2, time and sales: not available free from Yahoo, needs paid data (Nasdaq TotalView) or a broker API, link out instead
- Real-time streaming: Finnhub free websocket is the upgrade path if 15s polling ever feels slow, the proxy abstraction makes the swap clean, not needed now
- News and squawk: paid, add a link-out button to the Yahoo/Finviz news page for MU at most
- Earnings countdown: Yahoo's calendar endpoint needs crumb auth, pragmatic version is a manual earnings date field in Settings with a warning chip when within 7 days, cheap and useful on a name as earnings-volatile as MU
- Trade journal and P&L: Julian explicitly excluded it at the start, leave out unless he asks
- Halt detection: keep the heuristic stale pill, sharpen the copy only

## Housekeeping per binding rules

- Backup before edits: `Backups/MU Index Backup (11 Jun) pre-production-gaps.html`
- The user guide currently in `Docs/MU Dashboard Guide v1 (4 Jun).md` should move to Notion (official-use docs rule) with the in-repo file replaced by a pointer, do this in the execution session
- GitHub push and Pages hosting are still pending for this project, alerts on the phone require the page to be reachable, ask Julian before pushing (once per session rule)
- Worker deploy is still on Julian's side, Phase 2 item 19 depends on it

## Financial risk flags (restate to Julian)

- Yahoo is an unofficial, delayed-capable feed polled at 15s, signals can lag the tape by 30 to 60s, fine for planning entries, not safe for sub-minute scalping
- Indicator values from polled bars will differ from broker values, the in-app disclaimer already says so, keep it
- The app must stay read-only, no order routing, alerts are prompts to look, not advice to trade

## Verification (execution session)

- Backup taken before first edit, version badge bumped and matching the commit version
- Phase 0: open with `?symbol=NVDA`, confirm MU alerts do not evaluate, notification title shows the right symbol, kill the proxy and confirm backoff slows polling (watch network tab), reload and confirm instant paint from cache with stale pill
- Phase 1: against live or cached data confirm levels match Yahoo's own prev-day values, RVOL sanity-check against Finviz, ATR against TradingView (small tolerance), sizing maths by hand
- All UI: browser check per UI Quality Standard, golden path plus empty states, mobile 375px, no console errors
- Holiday clock: spoof a 2026 holiday date and confirm the pill says closed

---

*Disposable point-in-time doc. Delete once fully actioned (see CLAUDE.md, Folder cleanliness).*
