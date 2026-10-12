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
import { NYSE_HOLIDAYS, NYSE_HALF_DAYS } from "./nyse-holidays.js";

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
async function safeSecretEqual(supplied, expected) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return false;
  const enc = new TextEncoder();
  const [suppliedHash, expectedHash] = await Promise.all([
    subtle.digest("SHA-256", enc.encode(String(supplied))),
    subtle.digest("SHA-256", enc.encode(String(expected))),
  ]);
  const a = new Uint8Array(suppliedHash);
  const b = new Uint8Array(expectedHash);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
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
async function requireAlertAuth(request, env, origin, ip, routeKey) {
  if (!env.ALERTS_SECRET) return err(503, "ALERTS_SECRET not configured", origin);
  if (!(await checkRateLimit(env, ip + ":" + routeKey))) return err(429, "rate limited", origin);
  const supplied = request.headers.get("X-Alerts-Secret") || "";
  let authorised = false;
  try { authorised = await safeSecretEqual(supplied, env.ALERTS_SECRET); } catch (e) {}
  return authorised ? null : err(401, "unauthorized", origin);
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
  if (!resp.ok) throw new Error("Yahoo chart HTTP " + resp.status);
  const data = await resp.json();
  if (data?.chart?.error) throw new Error(data.chart.error.description || "Yahoo chart error");
  const result = data?.chart?.result?.[0] ?? null;
  if (!result) throw new Error("Yahoo chart returned no result");
  return result;
}

function isRegularSession(unixSec) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false,
  });
  const parts = fmt.formatToParts(new Date(unixSec * 1000));
  const h  = parseInt(parts.find(p => p.type === "hour").value);
  const mn = parseInt(parts.find(p => p.type === "minute").value);
  const total = h * 60 + mn;
  const dateKey = etDateKey(unixSec);
  if (NYSE_HOLIDAYS.has(dateKey)) return false;
  const closeMin = NYSE_HALF_DAYS.has(dateKey) ? 780 : 960;
  return total >= 570 && total < closeMin;
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
  const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  let body = null;
  try { body = JSON.parse(await response.text()); } catch (e) {}
  if (!response.ok) throw new Error("Telegram delivery failed (HTTP " + response.status + ")");
  if (!body || body.ok !== true) throw new Error("Telegram delivery was not accepted");
  return true;
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
  // NYSE holidays and early closes come from the shared calendar so scheduled
  // alert delivery follows the same regular-session boundaries as bar parsing.
  const dparts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const dmap = {}; dparts.forEach(p => { dmap[p.type] = p.value; });
  const dateKey = dmap.year + "-" + dmap.month + "-" + dmap.day;
  if (NYSE_HOLIDAYS.has(dateKey)) return false;
  const h  = parseInt(parts.find(p => p.type === "hour").value);
  const mn = parseInt(parts.find(p => p.type === "minute").value);
  const total = h * 60 + mn;
  const closeMin = NYSE_HALF_DAYS.has(dateKey) ? 780 : 960;
  return total >= 570 && total < closeMin;
}

function applyRuntimeState(configAlerts, runtime, revision) {
  const sourceRevision = runtime?.sourceRevision ?? runtime?.sourceUpdatedAt;
  if (!runtime || sourceRevision !== revision || !runtime.states) return configAlerts;
  return configAlerts.map(a => {
    const s = runtime.states[a.id];
    return s ? { ...a, enabled: s.enabled !== false, armed: !!s.armed,
      prevCond: s.prevCond ?? null, lastFiredAt: s.lastFiredAt ?? null } : a;
  });
}

function buildRuntimeState(alerts, revision, now) {
  const states = {};
  for (const a of alerts) {
    if (!a?.id) continue;
    states[a.id] = { enabled: a.enabled !== false, armed: !!a.armed,
      prevCond: a.prevCond ?? null, lastFiredAt: a.lastFiredAt ?? null };
  }
  return { sourceRevision: revision, updatedAt: now, lastEvalAt: now, states };
}

function makeAlertRevision(updatedAt) {
  let entropy = "";
  try { entropy = globalThis.crypto?.randomUUID?.() || ""; } catch (e) {}
  if (!entropy) entropy = Math.random().toString(36).slice(2);
  return String(updatedAt) + ":" + entropy;
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
      const authError = await requireAlertAuth(request, env, origin, ip, "telegram-test");
      if (authError) return authError;
      if (!env.TELEGRAM_TOKEN) return jsonResp({ ok: false, error: "TELEGRAM_TOKEN secret not set" }, 503, origin);
      if (!env.MU_ALERTS)      return jsonResp({ ok: false, error: "KV not configured" }, 503, origin);
      const data = await env.MU_ALERTS.get("alerts:MU", { type: "json" });
      const chatId = data?.chatId;
      if (!chatId) return jsonResp({ ok: false, error: "No chatId stored, sync alerts from the dashboard first" }, 400, origin);
      try {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "MU Dashboard\nTelegram connection test.");
        return jsonResp({ ok: true }, 200, origin);
      } catch (e) { return jsonResp({ ok: false, error: "Telegram test failed" }, 502, origin); }
    }

    // POST /alerts, requires shared-secret auth (X-Alerts-Secret header) so only Julian's
    // own app instance can register/overwrite alert config and Telegram chatId.
    if (request.method === "POST" && url.pathname === "/alerts") {
      const authError = await requireAlertAuth(request, env, origin, ip, "alerts-post");
      if (authError) return authError;

      let body;
      try { body = await request.json(); } catch (e) { return err(400, "bad JSON", origin); }
      const { symbol, chatId, alerts } = body || {};
      const enabled = body?.enabled !== false;
      if (!symbol || !SYMBOL_RE.test(symbol.toUpperCase())) return err(400, "bad symbol", origin);
      if (enabled && !chatId) return err(400, "chatId required", origin);
      if (!Array.isArray(alerts)) return err(400, "alerts must be array", origin);
      if (!env.MU_ALERTS) return err(503, "KV binding MU_ALERTS not configured", origin);
      const sym = symbol.toUpperCase();
      const updatedAt = Date.now();
      const stored = {
        enabled, chatId: chatId || "", symbol: sym,
        alerts: alerts.map(a => ({
          id: a.id, type: a.type, value: a.value,
          oneShot: !!a.oneShot, cooldownMs: a.cooldownMs || 0,
          enabled: a.enabled !== false, armed: !!a.armed,
          prevCond: a.prevCond ?? null, lastFiredAt: a.lastFiredAt ?? null,
        })),
        updatedAt,
        revision: makeAlertRevision(updatedAt),
      };
      await env.MU_ALERTS.put("alerts:" + sym, JSON.stringify(stored));
      return jsonResp({ ok: true, count: alerts.length, enabled }, 200, origin);
    }

    // GET /alerts?symbol=X
    if (request.method === "GET" && url.pathname === "/alerts") {
      const authError = await requireAlertAuth(request, env, origin, ip, "alerts-get");
      if (authError) return authError;
      if (!env.MU_ALERTS) return err(503, "KV binding MU_ALERTS not configured", origin);
      const sym = (url.searchParams.get("symbol") || "MU").toUpperCase();
      if (!SYMBOL_RE.test(sym)) return err(400, "bad symbol", origin);
      const data = await env.MU_ALERTS.get("alerts:" + sym, { type: "json" });
      if (!data) return jsonResp({ alerts: [] }, 200, origin);
      let runtime = null;
      try { runtime = await env.MU_ALERTS.get("alertstate:" + sym, { type: "json" }); } catch (e) {}
      const revision = data.revision ?? data.updatedAt;
      return jsonResp({
        symbol: data.symbol,
        enabled: data.enabled !== false,
        alerts: applyRuntimeState(Array.isArray(data.alerts) ? data.alerts : [], runtime, revision),
        updatedAt: data.updatedAt ?? null,
        lastEvalAt: runtime?.lastEvalAt ?? data.lastEvalAt ?? null,
      }, 200, origin);
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

    const keys = [];
    let cursor;
    do {
      let page;
      try {
        page = await env.MU_ALERTS.list(cursor ? { prefix: "alerts:", cursor } : { prefix: "alerts:" });
      } catch (e) {
        console.error("scheduled: alert key listing failed: " + String(e));
        return;
      }
      if (Array.isArray(page?.keys)) keys.push(...page.keys);
      cursor = page?.list_complete === false ? page.cursor : null;
    } while (cursor);
    if (!keys.length) return;

    const now   = Date.now();
    const token = env.TELEGRAM_TOKEN;

    for (const key of keys) {
      let data;
      try {
        data = await env.MU_ALERTS.get(key.name, { type: "json" });
      } catch (e) {
        console.error("scheduled: KV read failed for " + key.name + ": " + String(e));
        continue;
      }
      if (data?.enabled === false || !data?.alerts?.length || !data.chatId) continue;

      let runtime = null;
      try { runtime = await env.MU_ALERTS.get("alertstate:" + data.symbol, { type: "json" }); } catch (e) {}
      const revision = data.revision ?? data.updatedAt;
      const configuredAlerts = applyRuntimeState(data.alerts, runtime, revision);

      let result;
      try { result = await fetchYahoo(data.symbol, "1m", "1d", true); }
      catch (e) { console.error("scheduled: fetchYahoo failed for " + data.symbol + ": " + String(e)); continue; }

      const snap = parseAndSnap(result);
      if (!snap || snap.price == null) continue;

      let stateChanged = false;
      const nextAlerts = configuredAlerts.map(a => ({ ...a }));
      const deliveries = [];

      for (let i = 0; i < nextAlerts.length; i++) {
        const a = nextAlerts[i];
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
              deliveries.push({ index: i, cond, message: alertDesc(a) + " @ $" + snap.price.toFixed(2) });
              continue;
            }
          }
          if (a.prevCond !== cond) { a.prevCond = cond; stateChanged = true; }
        } else {
          if (cond && a.armed) {
            const inCd = a.cooldownMs && a.lastFiredAt && (now - a.lastFiredAt < a.cooldownMs);
            if (!inCd) {
              deliveries.push({ index: i, cond, message: alertDesc(a) + " @ $" + snap.price.toFixed(2) });
            } else {
              a.armed = false;
              stateChanged = true;
            }
          } else if (!cond && !a.armed) { a.armed = true; stateChanged = true; }
        }
      }

      if (deliveries.length) {
        const text = "<b>" + data.symbol + " Alert</b>\n"
          + deliveries.map(d => "• " + d.message).join("\n");
        try {
          await sendTelegram(token, data.chatId, text);
          for (const delivery of deliveries) {
            const a = nextAlerts[delivery.index];
            a.lastFiredAt = now;
            if (a.oneShot) a.enabled = false;
            if (CROSS_TYPES.has(a.type)) a.prevCond = delivery.cond;
            else a.armed = false;
          }
          stateChanged = true;
        } catch (e) {
          console.error("scheduled: Telegram delivery failed for " + data.symbol);
        }
      }

      if (stateChanged) {
        let latest;
        try {
          latest = await env.MU_ALERTS.get(key.name, { type: "json" });
        } catch (e) {
          console.error("scheduled: KV recheck failed for " + key.name + ": " + String(e));
          continue;
        }
        // A dashboard POST is the configuration authority. If its revision
        // changed during this tick, discard this stale evaluation; never write
        // it back over the new destination or alert set.
        const latestRevision = latest?.revision ?? latest?.updatedAt;
        if (!latest || latest.enabled === false || !latest.chatId || latestRevision !== revision) continue;
        try {
          await env.MU_ALERTS.put("alertstate:" + data.symbol,
            JSON.stringify(buildRuntimeState(nextAlerts, revision, now)));
        } catch (e) {
          console.error("scheduled: KV state write failed for " + key.name + ": " + String(e));
        }
      }
    }
  },
};
