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
