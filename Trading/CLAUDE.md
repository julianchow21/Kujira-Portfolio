# MU Day Trading

Single-file day-trading dashboard, default ticker MU (Micron, NASDAQ). Live price/change/volume, intraday candlestick chart, session indicators (VWAP, EMA 9/20, RSI 14, MACD), configurable alerts. Read-only public market data, no trade logging.

## Architecture

Single-file SPA, all CSS/JS/HTML in `index.html`. No framework, no bundler. Chart via TradingView Lightweight Charts v5.2.0 (CDN standalone, global `window.LightweightCharts`). v5 API: `chart.addSeries(LC.AreaSeries, ...)`, `chart.addPane()`, `series.attachPrimitive()`.

### Data spine

One Yahoo v8 chart call per refresh: `query1.finance.yahoo.com/v8/finance/chart/<SYM>?interval=&range=&includePrePost=`. `meta` gives price, prevClose (`chartPreviousClose`), day high/low, volume, marketState, regularMarketTime. `timestamp` + `indicators.quote[0]` give the OHLCV series feeding the chart and every indicator. `parseResult()` normalises both.

**Core vs chart split (important).** Header, indicator cards, and alerts are ALWAYS driven by today's 1m session (`lastCore`, `CORE_PARAMS`). The timeframe selector only changes the chart (`lastChart`) via `loadChart()`. Do not wire the header or alerts to `curTf`.

**Timeframes (`TIMEFRAMES`).** Tabs 1m / 5m / 15m / 1h / 1D, each a Yahoo interval+range pair Yahoo accepts (1m needs range <=7d, 15m <=60d, 60m <=730d). `intraday:true` for minute/hour bars (VWAP valid, ET time axis). The 1m tab reuses `lastCore` so switching to it is instant. Adding a tab means adding a valid combo.

### Proxy (CORS)

Browser cannot hit Yahoo directly. `cfg.proxyMode` in Settings: `public` (default, flaky trial proxies in `PUBLIC_PROXIES`, flagged in-UI), `worker` (Cloudflare Worker in `Worker/`, Julian's choice for real use, also serves `GET /quote?symbol=X` with crumb acquisition + 15-min KV cache for the fundamentals card), `appsscript` (Kujira Portfolio `/exec` with the `chart` action), `direct` (usually CORS-blocked). All return Yahoo's native JSON so `parseResult` is unchanged.

### Indicators

Client-side from the series: `ema()`, `rsi()` (Wilder), `macd()` (12/26/9), `vwapSeries()` (resets each market day via `etDateKey()`, regular-session bars only via `isRegularSession()`, null outside). VWAP overlay on intraday timeframes only. Cards are always session/intraday from `lastCore`; chart overlays use the displayed timeframe's series, so they differ from the cards on coarser timeframes by design.

### Alerts

`alerts[]` in localStorage, edge-triggered: fire once when the condition becomes true, re-arm when it goes false (`armed` flag). Types: price above/below, RSI above/below, price x VWAP, EMA9 x EMA20. Visual flash + toast + optional Notification + optional beep, evaluated every refresh from the core snapshot. Fixed bottom alert bar with chips + cancel (5s UNDO). `autoSyncAlerts()` debounces TG sync 1.5s after any mutation, preview guard skips sync on localhost/file://.

### Key mechanics (accreted v3.0 to v3.4, git holds the full change history)

- Default ticker resolution: `?symbol=` URL param, else `cfg.defaultSymbol`, else `"MU"`. The `SYMBOL` IIFE reads localStorage directly (`cfg` and `TICKER_RE` are in TDZ at that point)
- `fitForTf()` / `refitChart()` replace bare `fitContent()`: reset `autoScale` first (clears sticky zoom) then `setVisibleLogicalRange` with `fitBars` windows, double-rAF after `setData`
- `DayBands` primitive (LWC `ISeriesPrimitive` on `sLine`) shades odd ET trading days on 5m/15m/1h, feed bar times via `dayBands.setTimes()` from `paintChart`, disabled on 1m and 1D
- Pinned indicator pills: `cfg.pinnedOverlays`, `renderToggles()` re-renders the row, all clicks event-delegated on `#togglesDyn` using `onclick` assignment (addEventListener stacked listeners on the persistent element)
- Key levels: `cfg.levelLines[label]===false` hides a level from the chart, `SHORT_LVL` maps labels to single letters in-pane, `renderLevels` draws the gauge strip with O/H/L ticks + prices and removable custom chips (`cfg.customLevels`)
- `cfg.chartStyle` `"area"`|`"candles"`: `applyChartStyle()` makes `sLine` transparent in candle mode (hiding it breaks price lines and DayBands), `sCandle` is a separate series
- SGT chart display via `fmtClockSG`/`fmtDateSG` in tick/crosshair formatters only, 1D keeps ET dates (off-by-one risk), all session internals stay ET
- Fundamentals card (P/E, Fwd P/E, EPS, Mkt Cap, 52W Hi/Lo): `fetchQuote()` at boot + 15-min interval, Worker mode only
- `TICKER_META` / `cfg.tickerMeta`: static ~90-ticker map + user overrides, edit popover reached from the ticker-switcher dropdown, which also holds the launch pin (`cfg.defaultSymbol`)
- Snap-to-open: while closed, `scheduleNext` lands the next fetch ~3s after `nextOpenMs()`. Price pulse compares `_lastShownPx`, skips the cold-start cache paint
- `parseResult` company-name fallback is `m.symbol||SYMBOL`, never a hardcoded name. Footer symbol via `#footSym`

## Gotchas

- Lightweight Charts fit-after-setData: call the fit inside `requestAnimationFrame` after `setData`, otherwise a timeframe switch fits against the previous layout. See `refitChart()`
- Multi-day intraday axis: use `tickMarkFormatter`'s second arg (`tickMarkType`), <=2 is a date boundary so show the date, >=3 shows the clock
- Market clock is DST-aware via Intl (`America/New_York`). NYSE holidays and half days ARE handled (`NYSE_HOLIDAYS`/`NYSE_HALF_DAYS`, hardcoded through 2028, extend before 2029)
- `.topbar` has z-index:100 so the settings drawer (z-index:201) and scrim paint above the backdrop-filter topbar
- Chart axis and crosshair times are ET (market time), not SGT
- Volume series has `lastValueVisible:false` so it does not paint a stray `$0.00` price tag
- No writes to any shared store (read-only data), so the localhost guard only shows a "preview" note, it does not disable fetching

## Design tokens

Ported from Investment Tracker: `--bg/bg2/bg3/bg4`, `--green` (gains) / `--red` (losses), `--accent:#2962FF`, `--accent2:#1565C0` (TradingView blue), `--blue` (EMA9), `--amber` (EMA20), `--radius:6px`, `--radius-lg:8px`. Dark only.

## Files

- `index.html`, the dashboard (runtime name)
- `Worker/`, Cloudflare Worker proxy (`MU Yahoo Worker v3 (13 Jun).js`) plus the optional Apps Script chart-action snippet
- `Docs/`, point-in-time reports and specs (disposable once actioned)

## Hosting

Static, GitHub Pages or open locally. For real use deploy the Worker and point Settings at it. Footer and Settings carry the disclaimer: not financial advice, data may be delayed, confirm against your broker.
