# MU Day Trading dashboard, guide

Live MU (Micron) dashboard for fast intraday decisions. Price, change, volume, an intraday candlestick chart with a 1m / 5m / 15m / 1h / 1D timeframe toggle, the indicators day traders watch (VWAP, EMA 9/20, RSI, MACD), and alerts on price or indicators. It pulls the numbers for you, so no more typing them into a sheet.

**For information only. Not financial advice. Yahoo data can be delayed and is not tick-accurate. Always confirm against your broker before trading.**

## Set up live data: deploy the Cloudflare Worker

The browser cannot call Yahoo directly (no CORS), and free public proxies are unreliable (they go down or get paywalled). A Cloudflare Worker is your own tiny proxy, free, fast, and isolated so nothing else can break it. About 5 minutes, one time.

1. Go to dash.cloudflare.com, then Workers & Pages, Create, Create Worker.
2. Give it a name, e.g. `mu-yahoo`. Deploy.
3. Click Edit code. Delete the sample, paste the contents of `Worker/MU Yahoo Worker v1 (4 Jun).js`. Deploy.
4. Copy the Worker URL, e.g. `https://mu-yahoo.<your-subdomain>.workers.dev`.
5. Quick check: open `<that URL>/?symbol=MU&interval=1m&range=1d` in a browser. You should see JSON starting with `{"chart":...`.
6. In the dashboard: gear icon, Settings, Data proxy, choose "Cloudflare Worker", paste the URL, Test connection. It should say "Connected".
7. Optional, lock it down: in the Worker file set `ALLOWED_ORIGIN` to your dashboard URL and redeploy, so only your site can use it.

That is it. The dashboard now has a reliable live feed.

### Alternative: reuse your Kujira Portfolio Apps Script

If you ever want to avoid the Worker, that backend already proxies Yahoo. Add the `chart` action from `Docs/Apps Script Chart Action v1 (4 Jun).js`, redeploy (Manage deployments, Edit, New version, keeps the URL), then in Settings choose "Apps Script /exec" and paste the `/exec` URL. The Worker is the lower-maintenance option, this is the no-new-account option.

## Using it

- **Timeframe:** 1m / 5m / 15m / 1h / 1D switches the chart only. Price, stats, indicators, and alerts always stay on today's session.
- **1m and 5m** are minute-level intraday. **15m** and **1h** give you a few weeks to a few months of intraday context. **1D** is six months of daily candles.
- **Overlays:** toggle VWAP / EMA 9 / EMA 20. VWAP shows on intraday timeframes only (it resets each session) and is hidden on the daily view.
- **Alerts:** pick a type, set a value if needed, Add. They fire once when triggered and re-arm when the condition clears. Turn on notifications (button in the alert bar) and sound (Settings).
- **Refresh:** auto every 15 seconds when the market is open (about 21:30 to 04:00 SGT), slower when closed, paused when the tab is hidden. The refresh button forces an update.

## Market hours

US market (NASDAQ) regular hours are 09:30 to 16:00 ET. The pill at the top shows the state and counts down to the next open when closed. Turn on "Include pre / post-market" in Settings for extended-hours bars on intraday timeframes.

## Notes

- Indicators are computed from the displayed data and can differ slightly from your broker's platform.
- Holidays are not in the market clock, only weekends. On a US holiday the pill may say open when it is not, so check the data age (top right).
- Data freshness shows top right. During market hours a "stale" pill appears if the feed lags more than 3 minutes.
