# MU Day Trading

Single-file day-trading dashboard for MU (Micron, NASDAQ). Live price/change/volume, intraday candlestick chart, session indicators (VWAP, EMA 9/20, RSI 14, MACD), and configurable alerts. Read-only public market data, no trade logging.

## Architecture

Single-file SPA, all CSS/JS/HTML in `index.html`. No framework, no bundler. Chart via TradingView Lightweight Charts **v5.2.0** (CDN standalone, global `window.LightweightCharts`). v5 API: `chart.addSeries(LC.AreaSeries, …)`, `chart.addPane()`, `series.attachPrimitive()`.

### Data spine

One Yahoo v8 chart call per refresh: `query1.finance.yahoo.com/v8/finance/chart/MU?interval=&range=&includePrePost=`. `meta` gives price, prevClose (`chartPreviousClose`), day high/low, volume, marketState, regularMarketTime. `timestamp` + `indicators.quote[0]` give the OHLCV series that feeds the chart and every indicator. `parseResult()` normalises both. Same endpoint the Investment Tracker Apps Script already proxies.

**Core vs chart split (important).** The header, indicator cards, and alerts are ALWAYS driven by today's 1m session (`lastCore`, `CORE_PARAMS`). The timeframe selector only changes the chart (`lastChart`) via `loadChart()`. This keeps the live numbers anchored to today and means alerts keep firing on any timeframe. Do not wire the header or alerts to `curTf`.

**Timeframes (`TIMEFRAMES`).** Tabs are 1m / 5m / 15m / 1h / 1D, each a Yahoo interval+range pair that Yahoo accepts (e.g. 1m needs range <=7d, 15m <=60d, 60m <=730d). `intraday:true` for minute/hour bars (VWAP valid, ET time axis). The `1m` tab reuses `lastCore` (same data), so switching to it is instant. Adding a tab means adding a valid combo to `TIMEFRAMES`.

### Proxy (CORS)

Browser cannot hit Yahoo directly. `cfg.proxyMode` in Settings:
- `public` (default): trial-only public CORS proxies, fallback chain in `PUBLIC_PROXIES`. Flaky, flagged in-UI, not for real-money decisions.
- `worker`: Cloudflare Worker, code in `Worker/`. Recommended for real use (Julian chose this).
- `appsscript`: Kujira Portfolio `/exec` after adding the `chart` action, see `Worker/Apps Script Chart Action`.
- `direct`: raw Yahoo, usually CORS-blocked, falls back to public.

All proxies return Yahoo's native JSON so `parseResult` is unchanged.

### Indicators

Client-side from the series: `ema()`, `rsi()` (Wilder), `macd()` (12/26/9), `vwapSeries()` (resets at each market day via `etDateKey()`, regular-session bars only via `isRegularSession()`, null outside). VWAP overlay shows on intraday timeframes only (hidden on 1D daily). Cards are always session/intraday (from `lastCore`); chart overlays use the displayed timeframe's series, so on coarser timeframes the chart EMAs differ from the cards by design.

### Alerts

`alerts[]` in localStorage, edge-triggered: fire once when the condition becomes true, re-arm when it goes false (`armed` flag). Types: price above/below, RSI above/below, price x VWAP, EMA9 x EMA20. Visual flash + toast + optional Notification + optional beep. Evaluated every refresh from the core snapshot.

## v3.4 additions (14 Jun)

- **Gauge labels on the bar:** `renderLevels` now draws the O/H/L letter above each anchor pin (coloured by `l.hex`) and the level price below it (`.lev-tick-lbl` / `.lev-tick-px`). The separate O/H/L word-key is gone (redundant). Current-price pin label (`.lev-pin-px`) bumped to 12px/800 so the live price stays the most prominent. Custom × chips legend unchanged. Minor ticks stay unlabelled (tooltip on hover/touch)
- **Stale-MU fixes:** company-name fallback in `parseResult` was hardcoded `"Micron Technology"`, so any ticker whose Yahoo chart meta lacked `shortName` showed Micron. Now falls back to `m.symbol||SYMBOL`. Footer disclaimer "Live MU data" was literal; wrapped the symbol in `#footSym`, set to `SYMBOL` at boot
- **Snap-to-open refresh:** `scheduleNext` now, while closed, shortens the next fetch to land ~3s after `nextOpenMs()` so live data appears at the bell instead of up to 5 min later. The 1s clock tick already flips the market pill live
- **Price pulse:** `renderHeader` flashes `#px` green on an up-tick / red on a down-tick (`.px-up` / `.px-down`, 1.1s ease-out) by comparing against `_lastShownPx`. Skips the cold-start cache paint (only pulses on real changes)

## v3.3 additions (14 Jun)

- **App-switch tabs:** topbar now has a `.tb-tabs` segmented control after the logo: `Trading` (active, current page) + `Portfolio` (link to `../Portfolio/`). Replaces the old ⬡ icon cross-link that sat in `.tb-right`
- **Bigger whale logo:** `.logo-whale` 30px → 42px, radius 6→8. Wordmark font bumped one step
- **Version badge in topbar:** `.tb-ver` chip (`v3.3 (14 Jun)`) added to `.tb-right` before the refresh/gear buttons, matching the footer badge. Hidden under 560px (footer badge still shows)

## v3.2 additions (14 Jun)

- **Topbar declutter:** topbar now holds logo + ⬡/↻/⚙ only. Ticker identity (MU button, company name, market/stale pills) moved into a new `.px-head` row inside the hero price card, above the price line
- **MU as an obvious button:** `#sym` restyled as a bordered pill (filled bg, hover state, cursor pointer). `⇆` glyph via `::after`. `#wlBtn` ▾ removed; `#sym` click directly toggles `#wlDrop`
- **Launch pin in switcher:** `#pinBtn` ☆ removed from topbar. `renderWatchlist` prepends a `.wl-head` with `#wlPinCur` ("☆ Open MU on launch") and `#wlEditInfo` ("✎ Edit ticker info") rows inside the dropdown. `toggleLaunchPin()` flips `cfg.defaultSymbol`. `renderPinBtn` is a no-op stub
- **Age pill removed:** `#agePill` element gone. `renderAge` no longer sets the age text; stale detection and `#stalePill` logic unchanged
- **Sector/cap chips hidden:** `renderSymMeta` removes `#symMeta` (no chips on the card). "Edit ticker info" still opens `openSymPop` from the switcher dropdown
- **Short chart level labels:** `SHORT_LVL` map converts long labels to single-letter codes (O/H/L/PC/PDH/PDL/PMH/PML/ORH/ORL/OR30H/OR30L) in `updateChartLevels`. Custom lines show `C`. Numeric axis labels (`axisLabelVisible:true`) unchanged
- **Slim Key Levels strip:** `renderLevels` keeps gauge strip only (no per-level eye/alert rows). Slim legend below: O/H/L colour key + removable × chips per `cfg.customLevels` entry (`data-delcustom`). Key Levels card repositioned between `#chartCard` and `#fundCard`

## v3.1 additions (13 Jun)

- **Branding + static tab title:** Kujira whale logo + KUJIRA/Trading wordmark in topbar; `<title>` is always "Kujira Trading", whale PNG favicon; dynamic title/favicon rewrite in `renderHeader` removed
- **SGT chart display (ET internals untouched):** `fmtClockSG`/`fmtDateSG` swap in `tickMarkFormatter`, `localization.timeFormatter`, and crosshair tooltip only; 1D tab keeps ET date to avoid off-by-one daily labels; `DayBands` and all session logic stay ET
- **`cfg.chartStyle`:** `"area"` (default) or `"candles"`. `applyChartStyle()` styles sLine transparent in candle mode instead of hiding it (hiding breaks price lines and DayBands). `sCandle` is a separate `CandlestickSeries` created at init
- **Level-line defaults:** `cfg.lvDefaultsV31` one-time migration hides Prev Close, Prev Day Hi/Lo, PM High/Low, OR15/OR30 Hi/Lo by default; Today Open/Hi/Lo stay visible. `updateChartLevels` title = `l.lbl + " " + Math.round(l.px)` renders in-pane
- **Listener stacking fix:** `renderToggles` changed `dyn.addEventListener` to `dyn.onclick` (idempotent assignment). Root cause: `renderToggles` is re-entrant from every click branch on the persistent `#togglesDyn` element; stacked listeners doubled on each click, making unpin appear as no-op
- **Fundamentals card:** below chart card, 6 cells (P/E, Fwd P/E, EPS, Mkt Cap, 52W Hi/Lo). `fetchQuote()` at boot + 15-min interval; Worker `/quote` route with crumb+KV cache. Non-worker mode shows "needs Worker proxy" note
- **Alert bar:** fixed bottom bar, chips per enabled alert with status dot + cancel. Cancel = delete with 5s UNDO toast. `autoSyncAlerts()` debounces TG sync 1.5s after any mutation; preview guard skips sync on localhost/file://
- **Stats strip removed:** `renderHeader` no longer writes sOpen/sPrev/sHigh/sLow/sRange/sVol/sGap/sFromOpen. RVOL (`computeRvol`, `fetchRvolSeries`, `RVOL_PARAMS`) deleted; `renderRS` deleted, `fetchRSSeries` kept for chart RS overlay
- **Worker v3:** `GET /quote?symbol=X` with crumb acquisition (fc.yahoo.com + getcrumb), quoteSummary v10, KV cache `quote:<SYM>` 15 min. `wrangler.toml main` updated to v3 filename

## v3.0 additions (12 Jun)

- **Default ticker:** `cfg.defaultSymbol` — resolution order: `?symbol=` URL param → `cfg.defaultSymbol` → `"MU"`. The `SYMBOL` IIFE reads localStorage directly (cannot use `cfg` or `TICKER_RE` — both are in TDZ at that point)
- **`fitForTf()` / `fitBars`:** replaces bare `fitContent()`. Resets `autoScale` first (clears sticky user zoom), then uses `setVisibleLogicalRange` with `fitBars` windows for 15m (135) and 1h (105). All fit paths call `refitChart()` which double-rAFs `fitForTf()`
- **`DayBands` primitive:** shades odd-indexed ET trading days on multi-day intraday TFs (5m/15m/1h). Implemented as a LWC v5.2.0 `ISeriesPrimitive` attached to `sLine`. Feed it bar times via `dayBands.setTimes(times)` from `paintChart`. Disabled on 1m (`range:"1d"`) and 1D
- **Pinned indicator pills:** `cfg.pinnedOverlays` controls which pills show inline; the rest are in the `⋯` dropdown. `renderToggles()` re-renders the whole row on every toggle/pin change. All click handling is event-delegated on `#togglesDyn`
- **`levelLines` map:** `cfg.levelLines[label] === false` hides a key level from the chart (but not the card). `updateChartLevels` filters before drawing. Eye toggles in `renderLevels` write to this map
- **`TICKER_META` / `cfg.tickerMeta`:** static map of ~90 tickers → `{i, s, t}`. `cfg.tickerMeta[SYMBOL]` overrides the map. `renderSymMeta()` injects chips after `#sym`; clicking opens an edit popover

## Gotchas

- **Lightweight Charts fit-after-setData:** call `fitContent()` inside `requestAnimationFrame` after `setData`, otherwise a timeframe switch fits against the previous timeframe's layout and bunches candles to one side. See `refitChart()`.
- **Multi-day intraday axis needs the tick type.** On a multi-day intraday chart (5m/15m/1h) every session starts at 09:30, so a time-only `tickMarkFormatter` prints "09:30" on every tick. Use the second arg (`tickMarkType`): `<=2` (Year/Month/DayOfMonth) is a date boundary so show the date, `>=3` (Time) shows the clock. The crosshair also shows date + time on intraday so you know which day.
- **Market clock is DST-aware via Intl** (`America/New_York`), not hardcoded offsets. Holidays are not handled (only weekends show "Closed").
- **`.topbar` has z-index:100** so the settings drawer (z-index:201) and its scrim paint above the backdrop-filter topbar.
- Chart axis and crosshair times are ET (market time), not SGT.
- Volume series has `lastValueVisible:false` so it does not paint a stray `$0.00` price tag.
- No writes to any shared store (read-only public data), so the localhost guard only shows a "preview" note, it does not disable fetching.

## Design tokens

Ported from Investment Tracker: `--bg/bg2/bg3/bg4`, `--green` (gains) / `--red` (losses), `--accent` #2dd4bf (VWAP), `--blue` (EMA9), `--amber` (EMA20), `--radius`. Dark only.

## Files

- `index.html` — the dashboard (canonical runtime name, no date prefix).
- `Worker/` — Cloudflare Worker proxy code (`MU Yahoo Worker v3 (13 Jun).js`) and the optional Apps Script chart-action snippet.
- `Docs/` — point-in-time reports and implementation specs (disposable once actioned).
- `Backups/` — dated `index.html` snapshots taken before significant changes.

## Hosting

Static. GitHub Pages or open locally. For real use, deploy the Worker and point Settings at it. Disclaimer in the footer and Settings: not financial advice, data may be delayed, confirm against your broker.
