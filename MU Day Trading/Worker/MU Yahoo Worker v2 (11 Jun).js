// MU Yahoo Worker v2 (11 Jun)
// Cloudflare Worker: CORS proxy + KV-backed server-side Telegram alerts.
//
// New in v2 vs v1:
//   POST /alerts   — dashboard syncs enabled alerts + Telegram chat ID into KV
//   GET  /alerts   — read current alert state (for debugging)
//   scheduled()    — cron fires every minute, evaluates conditions, pushes to Telegram
//
// Deployment steps (requires Wrangler CLI, not the paste-and-deploy UI):
//   1. Create the KV namespace:
//        wrangler kv:namespace create "MU_ALERTS"
//      Copy the printed id into wrangler.toml under [[kv_namespaces]].
//   2. Set the Telegram bot token as a Worker secret (never commit it):
//        wrangler secret put TELEGRAM_TOKEN
//      Create a bot first via @BotFather on Telegram if you haven't already.
//   3. Deploy:
//        wrangler deploy
//   4. In the dashboard Settings:
//      - Set proxy mode to "Cloudflare Worker" and paste the Worker URL.
//      - Enter your Telegram Chat ID (message @userinfobot to find it).
//      - Click "Sync alerts to Worker now".
//
// The Worker evaluates the same alert conditions as the dashboard and tracks
// edge-triggered state (prevCond) in KV so it only fires on transitions.

const ALLOWED_ORIGIN = "*"; // tighten to "https://<you>.github.io" once hosted
const INTERVALS = new Set(["1m","2m","5m","15m","30m","60m","90m","1h","1d","1wk","1mo"]);
const RANGES    = new Set(["1d","5d","1mo","3mo","6mo","1y","2y","5y","max"]);
const SYMBOL_RE = /^[A-Z.\-]{1,12}$/;
const CROSS_TYPES = new Set(["rsi_above","rsi_below","price_vwap_above","price_vwap_below","ema_bull","ema_bear"]);

function corsHeaders(methods = "GET, OPTIONS") {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders("GET, POST, OPTIONS") },
  });
}
function err(status, description) {
  return jsonResp({ chart: { result: null, error: { description } } }, status);
}

// ---- Yahoo fetch + parse ----

async function fetchYahoo(symbol, interval, range, pre = false) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol)
    + "?interval=" + interval + "&range=" + range + "&includePrePost=" + pre;
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    cf: { cacheTtl: 5, cacheEverything: true },
  });
  const data = await resp.json();
  return data?.chart?.result?.[0] ?? null;
}

function isRegularSession(unixSec) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false,
  });
  const parts = fmt.formatToParts(new Date(unixSec * 1000));
  const h  = parseInt(parts.find(p => p.type === "hour").value);
  const mn = parseInt(parts.find(p => p.type === "minute").value);
  const total = h * 60 + mn;
  return total >= 570 && total < 960; // 09:30–16:00 ET
}

function etDateKey(unixSec) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" })
    .format(new Date(unixSec * 1000));
}

function parseAndSnap(result) {
  if (!result) return null;
  const m  = result.meta || {};
  const ts = result.timestamp || [];
  const q  = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i]; if (c == null) continue;
    bars.push({
      time: ts[i],
      open: q.open?.[i] ?? c, high: q.high?.[i] ?? c, low: q.low?.[i] ?? c, close: c,
      volume: q.volume?.[i] ?? 0,
    });
  }

  const price = m.regularMarketPrice ?? bars.at(-1)?.close ?? null;
  const closes = bars.map(b => b.close);

  // EMA 9 + 20
  function ema(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
    return prev;
  }

  // RSI 14 (Wilder)
  function rsiLast(values, period = 14) {
    if (values.length <= period) return null;
    let ag = 0, al = 0;
    for (let i = 1; i <= period; i++) {
      const d = values[i] - values[i - 1]; if (d >= 0) ag += d; else al -= d;
    }
    ag /= period; al /= period;
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
      al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    }
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }

  // VWAP — today's regular-session bars only
  const today = bars.length ? etDateKey(bars[bars.length - 1].time) : null;
  let cumTP = 0, cumVol = 0;
  for (const b of bars) {
    if (!isRegularSession(b.time) || etDateKey(b.time) !== today) continue;
    cumTP += ((b.high + b.low + b.close) / 3) * b.volume;
    cumVol += b.volume;
  }
  const vwap = cumVol > 0 ? cumTP / cumVol : null;

  return { price, rsi: rsiLast(closes), vwap, ema9: ema(closes, 9), ema20: ema(closes, 20) };
}

function evalCond(a, snap) {
  const { price, rsi, vwap, ema9, ema20 } = snap;
  switch (a.type) {
    case "price_above":      return price != null && price >= a.value;
    case "price_below":      return price != null && price <= a.value;
    case "rsi_above":        return rsi   != null && rsi   >= a.value;
    case "rsi_below":        return rsi   != null && rsi   <= a.value;
    case "price_vwap_above": return price != null && vwap  != null && price > vwap;
    case "price_vwap_below": return price != null && vwap  != null && price < vwap;
    case "ema_bull":         return ema9  != null && ema20 != null && ema9  > ema20;
    case "ema_bear":         return ema9  != null && ema20 != null && ema9  < ema20;
  }
  return null;
}

function alertDesc(a) {
  const v = a.value != null ? Number(a.value).toFixed(2) : "";
  switch (a.type) {
    case "price_above":      return "Price ≥ $" + v;
    case "price_below":      return "Price ≤ $" + v;
    case "rsi_above":        return "RSI rose above " + v;
    case "rsi_below":        return "RSI fell below " + v;
    case "price_vwap_above": return "Price crossed above VWAP";
    case "price_vwap_below": return "Price crossed below VWAP";
    case "ema_bull":         return "EMA 9 crossed above EMA 20";
    case "ema_bear":         return "EMA 9 crossed below EMA 20";
  }
  return a.type;
}

async function sendTelegram(token, chatId, text) {
  await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

// ---- Market hours check (ET) ----
// Returns true if cron should run (09:25–16:05 ET covers open and close transitions).
function isMarketWindow() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short",
    hour: "numeric", minute: "numeric", hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const dow  = parts.find(p => p.type === "weekday").value;
  if (dow === "Sat" || dow === "Sun") return false;
  const h  = parseInt(parts.find(p => p.type === "hour").value);
  const mn = parseInt(parts.find(p => p.type === "minute").value);
  const total = h * 60 + mn;
  return total >= 565 && total <= 965; // 09:25–16:05
}

// ---- Main export ----

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders("GET, POST, OPTIONS") });
    }

    // POST /alerts — receive alert config from the dashboard
    if (request.method === "POST" && url.pathname === "/alerts") {
      let body;
      try { body = await request.json(); } catch (e) { return err(400, "bad JSON"); }
      const { symbol, chatId, alerts } = body || {};
      if (!symbol || !SYMBOL_RE.test(symbol.toUpperCase())) return err(400, "bad symbol");
      if (!chatId) return err(400, "chatId required");
      if (!Array.isArray(alerts)) return err(400, "alerts must be array");
      if (!env.MU_ALERTS) return err(503, "KV binding MU_ALERTS not configured");
      const sym = symbol.toUpperCase();
      // Reset edge-trigger state on sync so cron initialises cleanly on first run.
      const stored = {
        chatId, symbol: sym,
        alerts: alerts.map(a => ({
          id: a.id, type: a.type, value: a.value,
          oneShot: !!a.oneShot, cooldownMs: a.cooldownMs || 0,
          enabled: true, armed: true, prevCond: null, lastFiredAt: null,
        })),
        updatedAt: Date.now(),
      };
      await env.MU_ALERTS.put("alerts:" + sym, JSON.stringify(stored));
      return jsonResp({ ok: true, count: alerts.length });
    }

    // GET /alerts?symbol=X — inspect current state (debugging only)
    if (request.method === "GET" && url.pathname === "/alerts") {
      if (!env.MU_ALERTS) return err(503, "KV binding MU_ALERTS not configured");
      const sym = (url.searchParams.get("symbol") || "MU").toUpperCase();
      const data = await env.MU_ALERTS.get("alerts:" + sym, { type: "json" });
      return jsonResp(data || { alerts: [] });
    }

    // GET / — Yahoo proxy (unchanged from v1)
    const symbol   = (url.searchParams.get("symbol") || "MU").toUpperCase();
    const interval = url.searchParams.get("interval") || "1m";
    const range    = url.searchParams.get("range") || "1d";
    const pre      = url.searchParams.get("includePrePost") === "true";

    if (!SYMBOL_RE.test(symbol) || !INTERVALS.has(interval) || !RANGES.has(range)) {
      return err(400, "bad params");
    }

    const target = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol)
      + "?interval=" + interval + "&range=" + range + "&includePrePost=" + pre;

    try {
      const resp = await fetch(target, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        cf: { cacheTtl: 5, cacheEverything: true },
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

  // ---- Cron: evaluate alerts every minute during market hours ----
  async scheduled(event, env, ctx) {
    if (!env.MU_ALERTS || !env.TELEGRAM_TOKEN) return; // secrets not configured
    if (!isMarketWindow()) return;

    const list = await env.MU_ALERTS.list({ prefix: "alerts:" });
    if (!list.keys.length) return;

    const now   = Date.now();
    const token = env.TELEGRAM_TOKEN;

    for (const key of list.keys) {
      const data = await env.MU_ALERTS.get(key.name, { type: "json" });
      if (!data?.alerts?.length || !data.chatId) continue;

      let result;
      try { result = await fetchYahoo(data.symbol, "1m", "1d", true); }
      catch (e) { continue; }

      const snap = parseAndSnap(result);
      if (!snap || snap.price == null) continue;

      let stateChanged = false;
      const messages = [];

      for (const a of data.alerts) {
        if (!a.enabled) continue;
        const cond = evalCond(a, snap);
        if (cond === null) continue;

        if (CROSS_TYPES.has(a.type)) {
          if (a.prevCond === null || a.prevCond === undefined) {
            a.prevCond = cond; stateChanged = true; continue; // first run: initialise only
          }
          const prev = !!a.prevCond;
          if (cond && !prev) {
            const inCd = a.cooldownMs && a.lastFiredAt && (now - a.lastFiredAt < a.cooldownMs);
            if (!inCd) {
              messages.push(alertDesc(a) + " @ $" + snap.price.toFixed(2));
              a.lastFiredAt = now;
              if (a.oneShot) a.enabled = false;
            }
            stateChanged = true;
          }
          if (a.prevCond !== cond) { a.prevCond = cond; stateChanged = true; }
        } else {
          if (cond && a.armed) {
            const inCd = a.cooldownMs && a.lastFiredAt && (now - a.lastFiredAt < a.cooldownMs);
            if (!inCd) {
              messages.push(alertDesc(a) + " @ $" + snap.price.toFixed(2));
              a.lastFiredAt = now;
              if (a.oneShot) a.enabled = false;
            }
            a.armed = false; stateChanged = true;
          } else if (!cond && !a.armed) { a.armed = true; stateChanged = true; }
        }
      }

      if (messages.length) {
        const text = "<b>" + data.symbol + " Alert</b>\n"
          + messages.map(m => "• " + m).join("\n");
        try { await sendTelegram(token, data.chatId, text); } catch (e) {}
      }

      if (stateChanged) {
        data.lastEvalAt = now;
        await env.MU_ALERTS.put(key.name, JSON.stringify(data));
      }
    }
  },
};
