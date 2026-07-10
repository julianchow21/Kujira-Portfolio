// MU Yahoo Worker v3 (13 Jun)
// Cloudflare Worker: CORS proxy + KV-backed Telegram alerts + fundamentals quote cache.
//
// New in v3 vs v2:
//   GET /quote?symbol=X, crumb-authenticated Yahoo quoteSummary with 15-min KV cache.
//                          Returns flat JSON: trailingPE, forwardPE, trailingEps,
//                          marketCap, fiftyTwoWeekHigh, fiftyTwoWeekLow.
//
// Deployment:
//   1. wrangler deploy   (KV namespace and secrets already configured from v2)
//   2. curl "<worker-url>/quote?symbol=MU" (should return {ok:true,...})

// Origin allowlist (Julian's GitHub Pages origin, from repo remote julianchow21/Kujira-Portfolio).
// If you host elsewhere too (e.g. a custom domain or local preview), add it here.
const ALLOWED_ORIGINS = new Set([
  "https://julianchow21.github.io",
]);
const INTERVALS = new Set(["1m","2m","5m","15m","30m","60m","90m","1h","1d","1wk","1mo"]);
const RANGES    = new Set(["1d","5d","1mo","3mo","6mo","1y","2y","5y","max"]);
const SYMBOL_RE = /^[A-Z.\-]{1,12}$/;
const CROSS_TYPES = new Set(["rsi_above","rsi_below","price_vwap_above","price_vwap_below","ema_bull","ema_bear"]);
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Basic per-IP + per-symbol rate limit (KV-backed, short-window counter).
const RATE_LIMIT_MAX = 30;       // max requests
const RATE_LIMIT_WINDOW_S = 60;  // per this many seconds

function corsHeaders(methods = "GET, OPTIONS", origin = null) {
  return {
    "Access-Control-Allow-Origin": origin || "null",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, X-Alerts-Secret",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function resolveOrigin(request) {
  const origin = request.headers.get("Origin");
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : null;
}
async function checkRateLimit(env, key) {
  if (!env.MU_ALERTS) return true; // fail-open if KV unavailable, matches existing pattern
  const rlKey = "rl:" + key;
  try {
    const cur = await env.MU_ALERTS.get(rlKey);
    const count = cur ? parseInt(cur, 10) : 0;
    if (count >= RATE_LIMIT_MAX) return false;
    await env.MU_ALERTS.put(rlKey, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_S });
    return true;
  } catch (e) {
    return true; // fail-open on KV error, don't block legitimate traffic on an infra hiccup
  }
}
function jsonResp(data, status = 200, origin = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders("GET, POST, OPTIONS", origin) },
  });
}
function err(status, description, origin = null) {
  return jsonResp({ chart: { result: null, error: { description } } }, status, origin);
}

// ---- Crumb acquisition ----

async function acquireCrumb(env) {
  // Step 1: hit fc.yahoo.com to get a cookie
  const fcResp = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": DESKTOP_UA },
    redirect: "manual",
  });
  const setCookie = fcResp.headers.get("set-cookie") || "";
  const cookieVal = setCookie.split(";")[0]; // "B=..." or similar

  // Step 2: exchange cookie for crumb
  const crumbResp = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": DESKTOP_UA, "Cookie": cookieVal },
  });
  const crumb = (await crumbResp.text()).trim();
  if (!crumb || crumb.length < 3) throw new Error("empty crumb");

  const entry = JSON.stringify({ cookie: cookieVal, crumb });
  await env.MU_ALERTS.put("yh:crumb", entry, { expirationTtl: 43200 }); // 12h
  return { cookie: cookieVal, crumb };
}

async function getCrumb(env) {
  try {
    const cached = await env.MU_ALERTS.get("yh:crumb", { type: "json" });
    if (cached?.crumb) return cached;
  } catch (e) {}
  return await acquireCrumb(env);
}

// Unwrap Yahoo raw/fmt value objects
function raw(v) { return (v != null && typeof v === "object" && "raw" in v) ? v.raw : v; }

// ---- Quote fetch ----

async function fetchQuoteSummary(sym, env, retry = true) {
  let { cookie, crumb } = await getCrumb(env);

  const url = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/"
    + encodeURIComponent(sym)
    + "?modules=summaryDetail,defaultKeyStatistics&crumb=" + encodeURIComponent(crumb);

  let resp = await fetch(url, {
    headers: { "User-Agent": DESKTOP_UA, "Cookie": cookie, "Accept": "application/json" },
  });

  if ((resp.status === 401 || resp.status === 403) && retry) {
    // Invalidate cached crumb and retry once
    await env.MU_ALERTS.delete("yh:crumb").catch(() => {});
    ({ cookie, crumb } = await acquireCrumb(env));
    resp = await fetch(
      "https://query1.finance.yahoo.com/v10/finance/quoteSummary/"
        + encodeURIComponent(sym)
        + "?modules=summaryDetail,defaultKeyStatistics&crumb=" + encodeURIComponent(crumb),
      { headers: { "User-Agent": DESKTOP_UA, "Cookie": cookie, "Accept": "application/json" } },
    );
  }

  if (!resp.ok) throw new Error("Yahoo quoteSummary HTTP " + resp.status);
  const j = await resp.json();
  const result = j?.quoteSummary?.result?.[0];
  if (!result) throw new Error("empty quoteSummary result");

  const sd  = result.summaryDetail || {};
  const dks = result.defaultKeyStatistics || {};

  return {
    ok: true,
    trailingPE:       raw(sd.trailingPE)        ?? null,
    forwardPE:        raw(dks.forwardPE)         ?? null,
    trailingEps:      raw(dks.trailingEps)       ?? null,
    marketCap:        raw(sd.marketCap)          ?? null,
    fiftyTwoWeekHigh: raw(sd.fiftyTwoWeekHigh)   ?? null,
    fiftyTwoWeekLow:  raw(sd.fiftyTwoWeekLow)    ?? null,
  };
}

// ---- Yahoo chart fetch + parse ----

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
  return total >= 570 && total < 960;
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

  function ema(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
    return prev;
  }

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
    case "price_above":      return "Price >= $" + v;
    case "price_below":      return "Price <= $" + v;
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
  return total >= 565 && total <= 965;
}

// ---- Main export ----

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = resolveOrigin(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders("GET, POST, OPTIONS", origin) });
    }

    // Per-IP rate limit, applies to every route below (short KV-backed counter).
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    // GET /quote?symbol=X, fundamentals via Yahoo quoteSummary with crumb + KV cache
    if (request.method === "GET" && url.pathname === "/quote") {
      if (!env.MU_ALERTS) return jsonResp({ ok: false, error: "KV not configured" }, 503, origin);
      const sym = (url.searchParams.get("symbol") || "MU").toUpperCase();
      if (!SYMBOL_RE.test(sym)) return jsonResp({ ok: false, error: "bad symbol" }, 400, origin);
      if (!(await checkRateLimit(env, ip + ":" + sym))) {
        return jsonResp({ ok: false, error: "rate limited" }, 429, origin);
      }

      const cacheKey = "quote:" + sym;
      const TTL_MS = 15 * 60 * 1000;
      try {
        const cached = await env.MU_ALERTS.get(cacheKey, { type: "json" });
        if (cached?.ts && Date.now() - cached.ts < TTL_MS) return jsonResp(cached.data, 200, origin);
      } catch (e) {}

      try {
        const data = await fetchQuoteSummary(sym, env);
        await env.MU_ALERTS.put(cacheKey, JSON.stringify({ ts: Date.now(), data }), { expirationTtl: 3600 });
        return jsonResp(data, 200, origin);
      } catch (e) {
        // Negative-cache the failure briefly so an outage doesn't trigger a crumb-acquisition
        // thundering herd on every client refresh.
        const FAIL_TTL_S = 45;
        try {
          await env.MU_ALERTS.put(cacheKey, JSON.stringify({ ts: Date.now(), data: { ok: false, error: String(e) } }), { expirationTtl: FAIL_TTL_S });
        } catch (e2) {}
        return jsonResp({ ok: false, error: String(e) }, 502, origin);
      }
    }

    // GET /test-telegram
    if (request.method === "GET" && url.pathname === "/test-telegram") {
      if (!env.TELEGRAM_TOKEN) return jsonResp({ ok: false, error: "TELEGRAM_TOKEN secret not set" }, 503, origin);
      if (!env.MU_ALERTS)      return jsonResp({ ok: false, error: "KV not configured" }, 503, origin);
      const data = await env.MU_ALERTS.get("alerts:MU", { type: "json" });
      const chatId = data?.chatId;
      if (!chatId) return jsonResp({ ok: false, error: "No chatId stored, sync alerts from the dashboard first" }, 400, origin);
      try {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "MU Dashboard\nTelegram connection test.");
        return jsonResp({ ok: true, chatId }, 200, origin);
      } catch (e) { return jsonResp({ ok: false, error: String(e) }, 502, origin); }
    }

    // POST /alerts, requires shared-secret auth (X-Alerts-Secret header) so only Julian's
    // own app instance can register/overwrite alert config and Telegram chatId.
    if (request.method === "POST" && url.pathname === "/alerts") {
      if (!env.ALERTS_SECRET) return err(503, "ALERTS_SECRET not configured", origin);
      const supplied = request.headers.get("X-Alerts-Secret") || "";
      if (supplied !== env.ALERTS_SECRET) return err(401, "unauthorized", origin);
      if (!(await checkRateLimit(env, ip + ":alerts-post"))) return err(429, "rate limited", origin);

      let body;
      try { body = await request.json(); } catch (e) { return err(400, "bad JSON", origin); }
      const { symbol, chatId, alerts } = body || {};
      if (!symbol || !SYMBOL_RE.test(symbol.toUpperCase())) return err(400, "bad symbol", origin);
      if (!chatId) return err(400, "chatId required", origin);
      if (!Array.isArray(alerts)) return err(400, "alerts must be array", origin);
      if (!env.MU_ALERTS) return err(503, "KV binding MU_ALERTS not configured", origin);
      const sym = symbol.toUpperCase();
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
      return jsonResp({ ok: true, count: alerts.length }, 200, origin);
    }

    // GET /alerts?symbol=X
    if (request.method === "GET" && url.pathname === "/alerts") {
      if (!env.MU_ALERTS) return err(503, "KV binding MU_ALERTS not configured", origin);
      const sym = (url.searchParams.get("symbol") || "MU").toUpperCase();
      const data = await env.MU_ALERTS.get("alerts:" + sym, { type: "json" });
      return jsonResp(data || { alerts: [] }, 200, origin);
    }

    // GET /, Yahoo chart proxy
    const symbol   = (url.searchParams.get("symbol") || "MU").toUpperCase();
    const interval = url.searchParams.get("interval") || "1m";
    const range    = url.searchParams.get("range") || "1d";
    const pre      = url.searchParams.get("includePrePost") === "true";

    if (!SYMBOL_RE.test(symbol) || !INTERVALS.has(interval) || !RANGES.has(range)) {
      return err(400, "bad params", origin);
    }
    if (!(await checkRateLimit(env, ip + ":" + symbol))) {
      return err(429, "rate limited", origin);
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
        headers: { "Content-Type": "application/json", ...corsHeaders("GET, OPTIONS", origin) },
      });
    } catch (e) {
      return err(502, String(e), origin);
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.MU_ALERTS || !env.TELEGRAM_TOKEN) return;
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
      catch (e) { console.error("scheduled: fetchYahoo failed for " + data.symbol + ": " + String(e)); continue; }

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
            a.prevCond = cond; stateChanged = true; continue;
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
