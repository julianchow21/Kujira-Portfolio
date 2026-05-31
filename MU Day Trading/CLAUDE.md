# MU Day Trading

Single-file day-trading dashboard for MU (Micron, NASDAQ). Live price/change/volume, intraday candlestick chart, session indicators (VWAP, EMA 9/20, RSI 14, MACD), and configurable alerts. Read-only public market data, no trade logging.

## Architecture

Single-file SPA, all CSS/JS/HTML in `index.html`. No framework, no bundler. Chart via TradingView Lightweight Charts v4.2.0 (CDN, SRI-pinned `sha384-OK7v...`, global `window.LightweightCharts`).

### Data spine

One Yahoo v8 chart call per refresh: `query1.finance.yahoo.com/v8/finance/chart/MU?interval=&range=&includePrePost=`. `meta` gives price, prevClose (`chartPreviousClose`), day high/low, volume, marketState, regularMarketTime. `timestamp` + `indicators.quote[0]` give the OHLCV series that feeds the chart and every indicator. `parseResult()` normalises both. Same endpoint the Investment Tracker Apps Script already proxies.

**Core vs chart split (important).** The header, indicator cards, and alerts are ALWAYS driven by today's 1d data (`lastCore`). The range selector (1D/5D/1M) only changes the chart (`lastChart`) via `loadChart()`. This keeps the live numbers anchored to today and means alerts keep firing even when parked on 5D/1M. Do not wire the header or alerts to `curRange`.

### Proxy (CORS)

Browser cannot hit Yahoo directly. `cfg.proxyMode` in Settings:
- `public` (default): trial-only public CORS proxies, fallback chain in `PUBLIC_PROXIES`. Flaky, flagged in-UI, not for real-money decisions.
- `worker`: Cloudflare Worker, see `mu-yahoo-worker.js`. Recommended for real use.
- `appsscript`: Investment Tracker `/exec` after adding the `chart` action, see `apps-script-chart-snippet.js`.
- `direct`: raw Yahoo, usually CORS-blocked, falls back to public.

All proxies return Yahoo's native JSON so `parseResult` is unchanged.

### Indicators

Client-side from the series: `ema()`, `rsi()` (Wilder), `macd()` (12/26/9), `vwapSeries()` (anchored to the regular session via `isRegularSession()`, null outside). VWAP overlay shows on 1D only. Cards are always session/intraday (from `lastCore`); chart overlays use the displayed range's series, so on 5D/1M the chart EMAs differ from the cards by design.

### Alerts

`alerts[]` in localStorage, edge-triggered: fire once when the condition becomes true, re-arm when it goes false (`armed` flag). Types: price above/below, RSI above/below, price x VWAP, EMA9 x EMA20. Visual flash + toast + optional Notification + optional beep. Evaluated every refresh from the core snapshot.

## Gotchas

- **Lightweight Charts fit-after-setData:** call `fitContent()` / `setVisibleRange()` inside `requestAnimationFrame` after `setData`, otherwise a range switch fits against the previous range's layout and bunches candles to one side. See `refitChart()`.
- **Market clock is DST-aware via Intl** (`America/New_York`), not hardcoded offsets. Holidays are not handled (only weekends show "Closed").
- **`.topbar` has z-index:100** so the settings drawer (z-index:201) and its scrim paint above the backdrop-filter topbar.
- Chart axis and crosshair times are ET (market time), not SGT.
- Volume series has `lastValueVisible:false` so it does not paint a stray `$0.00` price tag.
- No writes to any shared store (read-only public data), so the localhost guard only shows a "preview" note, it does not disable fetching.

## Design tokens

Ported from Investment Tracker: `--bg/bg2/bg3/bg4`, `--green` (gains) / `--red` (losses), `--accent` #2dd4bf (VWAP), `--blue` (EMA9), `--amber` (EMA20), `--radius`. Dark only.

## Files

- `index.html` — the dashboard (canonical, no date prefix).
- `mu-yahoo-worker.js` — Cloudflare Worker proxy (recommended data path).
- `apps-script-chart-snippet.js` — optional `chart` action to reuse the Investment Tracker backend.
- `README.md` — user setup and usage.

## Hosting

Static. GitHub Pages or open locally. For real use, deploy the Worker and point Settings at it. Disclaimer in the footer and Settings: not financial advice, data may be delayed, confirm against your broker.
