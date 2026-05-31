// mu-yahoo-worker.js
// Cloudflare Worker: CORS proxy for the Yahoo Finance v8 chart endpoint.
// Returns Yahoo's native JSON unchanged, so the dashboard parser does not change.
// Locked to the chart endpoint and an allowlist of params, so it cannot be abused
// as an open proxy.
//
// Deploy (free, ~5 min):
//   1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker.
//   2. Replace the code with this file. Save and deploy.
//   3. Copy the Worker URL (e.g. https://mu-yahoo.<you>.workers.dev).
//   4. Dashboard -> Settings -> Data proxy -> "Cloudflare Worker" -> paste URL -> Test connection.
//   5. Optional: set ALLOWED_ORIGIN to your site, redeploy, so only your site can call it.

const ALLOWED_ORIGIN = "*"; // tighten to "https://<you>.github.io" once hosted
const INTERVALS = new Set(["1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "1wk", "1mo"]);
const RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "max"]);
const SYMBOL_RE = /^[A-Z.\-]{1,12}$/;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}
function err(status, description) {
  return new Response(JSON.stringify({ chart: { result: null, error: { description } } }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    const url = new URL(request.url);
    const symbol = (url.searchParams.get("symbol") || "MU").toUpperCase();
    const interval = url.searchParams.get("interval") || "1m";
    const range = url.searchParams.get("range") || "1d";
    const pre = url.searchParams.get("includePrePost") === "true";

    if (!SYMBOL_RE.test(symbol) || !INTERVALS.has(interval) || !RANGES.has(range)) {
      return err(400, "bad params");
    }

    const target = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) +
      "?interval=" + interval + "&range=" + range + "&includePrePost=" + pre;

    try {
      const resp = await fetch(target, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        cf: { cacheTtl: 5, cacheEverything: true }, // 5s edge cache, keeps intraday fresh
      });
      const body = await resp.text();
      return new Response(body, {
        status: resp.status,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    } catch (e) {
      return err(502, String(e));
    }
  },
};
