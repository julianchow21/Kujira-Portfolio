# MU Day Trading dashboard

Live MU (Micron) dashboard for fast intraday decisions. Price, change, volume, an intraday candlestick chart, the indicators day traders watch (VWAP, EMA 9/20, RSI 14, MACD), and alerts you can set on price or indicators. It pulls the numbers for you, so no more typing them into a sheet or onto paper.

**For information only. Not financial advice. Yahoo data can be delayed and is not tick-accurate. Always confirm against your broker before trading.**

## Quick start

1. Open `index.html` in a browser (double-click, or host on GitHub Pages).
2. It loads live MU data straight away through a public proxy. That proxy is fine for a look, but it is shared and flaky, so do not trade off it.
3. For reliable data, deploy the Worker (below) and switch to it in Settings.

## Reliable data: deploy the Cloudflare Worker (free, about 5 min)

1. Sign in at dash.cloudflare.com, then Workers & Pages, Create, Worker.
2. Replace the code with the contents of `mu-yahoo-worker.js`. Save and deploy.
3. Copy the Worker URL (e.g. `https://mu-yahoo.<you>.workers.dev`).
4. In the dashboard: gear icon, Settings, Data proxy, choose "Cloudflare Worker", paste the URL, Test connection.
5. Optional: in `mu-yahoo-worker.js` set `ALLOWED_ORIGIN` to your site URL and redeploy, so only your site can use it.

## Or reuse your Investment Tracker backend

If you would rather not deploy a Worker, add the `chart` action from `apps-script-chart-snippet.js` to that project's `apps-script.gs`, redeploy (Manage deployments, Edit, New version, which keeps the same URL), then in Settings choose "Apps Script /exec" and paste the `/exec` URL.

## Using it

- **Range:** 1D / 5D / 1M switches the chart only. The price, stats, indicators, and alerts always stay on today.
- **Overlays:** toggle VWAP / EMA 9 / EMA 20 on the chart. VWAP shows on 1D (it is a session measure).
- **Alerts:** pick a type, set a value if needed, Add. They fire once when triggered and re-arm when the condition clears. Turn on notifications (button in the alert bar) and sound (Settings).
- **Refresh:** auto every 15 seconds when the market is open (about 21:30 to 04:00 SGT), slower when closed, paused when the tab is hidden. The refresh button forces an update. Change the interval in Settings.

## Market hours

US market (NASDAQ) regular hours are 09:30 to 16:00 ET. The pill at the top shows the state (open, pre-market, after-hours, closed) and counts down to the next open when closed. Turn on "Include pre / post-market" in Settings for extended-hours bars on the 1D chart.

## Notes

- Indicators are computed from the displayed data and can differ slightly from your broker's platform.
- Holidays are not in the market clock, only weekends. On a market holiday the pill may say the market is open when it is not, so check the data age.
- Data freshness shows top-right ("17h ago" etc.). During market hours a "stale" pill appears if the feed lags more than 3 minutes.
