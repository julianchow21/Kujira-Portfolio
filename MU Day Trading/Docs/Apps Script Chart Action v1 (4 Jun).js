/* apps-script-chart-snippet.js
   Optional: reuse the Investment Tracker Apps Script backend instead of a Cloudflare Worker.

   The MU dashboard needs the full intraday OHLCV series, which the existing `prices`
   action does not return. This adds a `chart` action that returns Yahoo's native v8
   chart JSON, so the dashboard parser is unchanged.

   How to add:
     1. Open the Investment Tracker project's apps-script.gs.
     2. In doGet(e), next to the existing 'prices' / 'fx' routes, add:
          if (action === 'chart') return json_(fetchYahooChart_(e.parameter));
     3. Paste the fetchYahooChart_ function below anywhere in the file.
     4. Deploy: Manage deployments -> Edit (pencil) -> New version -> Deploy.
        Editing the existing deployment keeps the same /exec URL.
     5. Dashboard -> Settings -> Data proxy -> "Apps Script /exec" -> paste the /exec URL.

   Note: the existing json_() helper already returns JSON that the dashboard can read
   cross-origin (same as the `prices` action this project already serves to its client).
*/

/* ─── Yahoo chart series (for the MU day-trading dashboard) ───────────────
   Returns Yahoo's native v8 chart JSON. Short cache (15s) keeps intraday data
   fresh without hammering Yahoo on a fast-refresh dashboard.                 */
function fetchYahooChart_(p) {
  var symbol = String((p && p.symbol) || 'MU').toUpperCase();
  if (!/^[A-Z.\-]{1,12}$/.test(symbol)) {
    return { chart: { result: null, error: { description: 'bad symbol' } } };
  }
  var interval = String((p && p.interval) || '1m');
  var range = String((p && p.range) || '1d');
  var pre = String((p && p.includePrePost) || 'false') === 'true';

  var cache = CacheService.getScriptCache();
  var key = 'yc:' + symbol + ':' + interval + ':' + range + ':' + pre;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
    '?interval=' + interval + '&range=' + range + '&includePrePost=' + pre;
  try {
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (resp.getResponseCode() !== 200) {
      return { chart: { result: null, error: { description: 'HTTP ' + resp.getResponseCode() } } };
    }
    var j = JSON.parse(resp.getContentText());
    var out = {
      chart: {
        result: (j.chart && j.chart.result) || null,
        error: (j.chart && j.chart.error) || null,
      },
    };
    cache.put(key, JSON.stringify(out), 15); // seconds
    return out;
  } catch (err) {
    return { chart: { result: null, error: { description: String(err) } } };
  }
}
