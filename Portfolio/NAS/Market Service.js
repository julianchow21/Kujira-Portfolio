'use strict';

/*
 * Private, same-origin market proxy for Portfolio.
 *
 * The service deliberately has no dependency or persistent state. It accepts
 * only the five fixed GET routes below, constructs every upstream URL here,
 * and keeps successful responses in bounded in-memory caches. The default
 * request budget is 120 requests per IP and route per 60 seconds. Portfolio
 * has five refresh routes on a 60-second cadence, so this leaves room for a
 * manual retry without making the proxy an open request pump.
 */

const http = require('http');
const { URL } = require('url');

const PORT = 8081;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 8_000;
const DEFAULT_REQUEST_DEADLINE_MS = 20_000;
const DEFAULT_BODY_LIMIT_BYTES = 512 * 1024;
const DEFAULT_DOWNSTREAM_LIMIT_BYTES = 1 * 1024 * 1024;
const MAX_CONCURRENCY = 8;
const MAX_QUEUE = 256;
const MAX_CACHE_ENTRIES = 2_000;
const MAX_LIST_ITEMS = 50;
const MAX_REQUEST_URL_BYTES = 16 * 1024;
const QUOTE_TTL_MS = 300 * 1000;
const FX_TTL_MS = 300 * 1000;
const CRYPTO_TTL_MS = 300 * 1000;
const FUNDAMENTALS_TTL_MS = 6 * 60 * 60 * 1000;
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
const CRUMB_TTL_MS = 30 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 120;
const RATE_MAX_ENTRIES = 10_000;

const SYMBOL_RE = /^[A-Za-z0-9.^=:-]{1,32}$/;
const FX_PAIR_RE = /^[A-Z]{6}$/;
const COIN_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ALLOWED_UPSTREAM_HOSTS = new Set([
  'fc.yahoo.com',
  'query1.finance.yahoo.com',
  'api.coingecko.com'
]);

const USER_AGENT = 'Kujira-Portfolio-Market/1.0';
const JSON_HEADERS = Object.freeze({
  Accept: 'application/json'
});

const ROUTES = Object.freeze({
  '/market/v1/quotes': Object.freeze({ name: 'quotes', params: ['symbols'] }),
  '/market/v1/fundamentals': Object.freeze({ name: 'fundamentals', params: ['symbols'] }),
  '/market/v1/fx': Object.freeze({ name: 'fx', params: ['pairs'] }),
  '/market/v1/crypto': Object.freeze({ name: 'crypto', params: ['ids', 'vs'] }),
  '/market/v1/history': Object.freeze({ name: 'history', params: ['symbols', 'range'] })
});

const RANGE_RE = /^(?:1mo|3mo|6mo|1y)$/;

class ServiceError extends Error {
  constructor(code, message, status, upstreamStatus) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.status = status || 502;
    this.upstreamStatus = upstreamStatus == null ? null : upstreamStatus;
  }
}

class InputError extends ServiceError {
  constructor(message) {
    super('BAD_REQUEST', message, 400);
    this.name = 'InputError';
  }
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function rawNumber(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw')) {
    return numberOrNull(value.raw);
  }
  return numberOrNull(value);
}

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function resolveClock(clock) {
  let source;
  if (typeof clock === 'function') source = clock;
  else if (clock && typeof clock.now === 'function') source = () => clock.now();
  else source = () => Date.now();
  return () => {
    const value = source();
    const millis = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(millis) ? millis : Date.now();
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function cacheRead(cache, key, now, ttl) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now >= hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return cloneJson(hit.value);
}

function cacheWrite(cache, key, value, now, ttl, maxEntries) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { value: cloneJson(value), expiresAt: now + ttl });
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : MAX_CACHE_ENTRIES;
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function cacheClear(...caches) {
  caches.forEach((cache) => cache.clear());
}

function publicUpstreamError(error) {
  if (!(error instanceof ServiceError)) return 'Upstream request failed';
  switch (error.code) {
    case 'UPSTREAM_TIMEOUT':
      return 'Upstream request timed out';
    case 'REQUEST_DEADLINE':
      return 'Request deadline exceeded';
    case 'UPSTREAM_TOO_LARGE':
      return 'Upstream response too large';
    case 'UPSTREAM_REDIRECT':
      return 'Upstream redirect rejected';
    case 'UPSTREAM_HTTP':
      return error.upstreamStatus ? `HTTP ${error.upstreamStatus}` : 'Upstream request failed';
    case 'OVERLOADED':
      return 'Service busy';
    case 'UPSTREAM_DATA':
      return 'No data';
    case 'UPSTREAM_HOST':
      return 'Upstream host rejected';
    case 'COOKIE':
      return 'Yahoo session unavailable';
    case 'CRUMB':
      return 'Yahoo crumb unavailable';
    default:
      return 'Upstream request failed';
  }
}

function failureStatus(results) {
  const failures = results.filter((result) => !result.ok);
  if (!failures.length || failures.length < results.length) return 200;
  const timedOut = failures.every((result) => (
    result.error && (result.error.code === 'UPSTREAM_TIMEOUT' || result.error.code === 'REQUEST_DEADLINE')
  ));
  return timedOut ? 504 : 502;
}

function failureSummary(results) {
  const first = results.find((result) => !result.ok);
  return first ? publicUpstreamError(first.error) : null;
}

function createLimiter(limit) {
  let active = 0;
  const queue = [];

  function drain() {
    while (active < limit && queue.length) {
      const entry = queue.shift();
      if (entry.signal && entry.signal.aborted) {
        entry.reject(new ServiceError('REQUEST_DEADLINE', 'Request deadline exceeded', 504));
        continue;
      }
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          if (entry.signal && entry.abortListener) {
            entry.signal.removeEventListener('abort', entry.abortListener);
          }
          active -= 1;
          drain();
        });
    }
  }

  function run(task, signal) {
    if (signal && signal.aborted) {
      return Promise.reject(new ServiceError('REQUEST_DEADLINE', 'Request deadline exceeded', 504));
    }
    return new Promise((resolve, reject) => {
      if (queue.length >= MAX_QUEUE) {
        reject(new ServiceError('OVERLOADED', 'Upstream queue is full', 503));
        return;
      }
      const entry = { task, resolve, reject, signal, abortListener: null };
      if (signal) {
        entry.abortListener = () => {
          const index = queue.indexOf(entry);
          if (index !== -1) {
            queue.splice(index, 1);
            reject(new ServiceError('REQUEST_DEADLINE', 'Request deadline exceeded', 504));
          }
        };
        signal.addEventListener('abort', entry.abortListener, { once: true });
      }
      queue.push(entry);
      drain();
    });
  }

  return {
    run,
    get active() { return active; },
    get queued() { return queue.length; }
  };
}

function createRateLimiter(now, options) {
  const windowMs = options.rateWindowMs || RATE_WINDOW_MS;
  const limit = options.rateLimit || RATE_LIMIT_MAX;
  const maxEntries = options.rateMaxEntries || RATE_MAX_ENTRIES;
  const records = new Map();

  function cleanup(timestamp) {
    for (const [key, record] of records) {
      if (record.resetAt <= timestamp) records.delete(key);
    }
    while (records.size > maxEntries) {
      const oldest = records.keys().next();
      if (oldest.done) break;
      records.delete(oldest.value);
    }
  }

  function allow(ip, route, timestamp) {
    cleanup(timestamp);
    const key = `${ip}\u0000${route}`;
    let record = records.get(key);
    if (!record || record.resetAt <= timestamp) {
      record = { count: 0, resetAt: timestamp + windowMs };
      records.set(key, record);
      while (records.size > maxEntries) {
        const oldest = records.keys().next();
        if (oldest.done) break;
        records.delete(oldest.value);
      }
    }
    if (record.count >= limit) return false;
    record.count += 1;
    return true;
  }

  return {
    allow,
    cleanup: () => cleanup(now()),
    get size() { return records.size; },
    limit,
    windowMs
  };
}

function requestHeader(req, name) {
  const headers = req && req.headers;
  if (!headers) return null;
  const wanted = String(name).toLowerCase();
  if (typeof headers.get === 'function') {
    const value = headers.get(wanted);
    return value == null ? null : String(value);
  }
  const value = headers[wanted] == null ? headers[name] : headers[wanted];
  if (Array.isArray(value)) return value.join(',');
  return value == null ? null : String(value);
}

function directAddress(req) {
  if (req && req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
  if (req && req.connection && req.connection.remoteAddress) return String(req.connection.remoteAddress);
  return 'unknown';
}

function requestHasBody(req) {
  const contentLength = requestHeader(req, 'content-length');
  if (contentLength != null && !/^\s*\d+\s*$/.test(contentLength)) return true;
  if (contentLength != null && !/^\s*0\s*$/.test(contentLength)) return true;
  const transferEncoding = requestHeader(req, 'transfer-encoding');
  if (transferEncoding != null && transferEncoding.trim() !== '') return true;
  if (req && Object.prototype.hasOwnProperty.call(req, 'body')) {
    const body = req.body;
    if (body != null && (!(typeof body === 'string') || body.length > 0) && (!(Buffer.isBuffer(body)) || body.length > 0)) {
      return true;
    }
  }
  return false;
}

function parseRequestUrl(req) {
  if (!req || typeof req.url !== 'string') throw new InputError('Invalid request URL');
  // Node's request URL is an origin-form path. Reject absolute-form URLs so a
  // proxy or test double cannot smuggle a different request authority in.
  if (!req.url.startsWith('/')) throw new InputError('Invalid request URL');
  if (byteLength(req.url) > MAX_REQUEST_URL_BYTES) throw new InputError('Request URL is too large');
  try {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    if (parsed.hash) throw new InputError('URL fragments are not accepted');
    return parsed;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('Invalid request URL');
  }
}

function parseList(value, kind) {
  if (typeof value !== 'string' || value.length === 0) throw new InputError('List parameter is required');
  const values = value.split(',').map((part) => part.trim());
  if (values.length === 0 || values.length > MAX_LIST_ITEMS || values.some((part) => part.length === 0)) {
    throw new InputError('List is empty or too large');
  }
  const seen = new Set();
  values.forEach((part) => {
    let valid = false;
    let duplicateKey = part;
    if (kind === 'symbol') {
      valid = SYMBOL_RE.test(part);
      duplicateKey = part.toUpperCase();
    } else if (kind === 'pair') {
      valid = FX_PAIR_RE.test(part);
    } else {
      valid = COIN_ID_RE.test(part) && part.length <= 64;
    }
    if (!valid) throw new InputError('List contains an invalid value');
    if (seen.has(duplicateKey)) throw new InputError('List contains a duplicate value');
    seen.add(duplicateKey);
  });
  return values;
}

function parseParams(route, parsed) {
  const allowed = new Set(route.params);
  const seen = new Set();
  for (const key of parsed.searchParams.keys()) {
    if (!allowed.has(key)) throw new InputError('Unknown query parameter');
    if (seen.has(key)) throw new InputError('Duplicate query parameter');
    seen.add(key);
  }
  route.params.forEach((key) => {
    if (!seen.has(key)) throw new InputError('Required query parameter is missing');
  });

  const raw = Object.fromEntries(route.params.map((key) => [key, parsed.searchParams.get(key)]));
  if (route.name === 'quotes' || route.name === 'fundamentals' || route.name === 'history') {
    raw.symbols = parseList(raw.symbols, 'symbol');
  } else if (route.name === 'fx') {
    raw.pairs = parseList(raw.pairs, 'pair');
  } else if (route.name === 'crypto') {
    raw.ids = parseList(raw.ids, 'coin');
    if (raw.vs !== 'sgd,usd') throw new InputError('vs must be exactly sgd,usd');
  }
  if (route.name === 'history' && !RANGE_RE.test(raw.range)) {
    throw new InputError('range is not supported');
  }
  return raw;
}

function outboundUrl(value, expectedHost) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new ServiceError('UPSTREAM_HOST', 'Upstream host rejected', 502);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== expectedHost ||
    parsed.port !== '' ||
    !ALLOWED_UPSTREAM_HOSTS.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new ServiceError('UPSTREAM_HOST', 'Upstream host rejected', 502);
  }
  return parsed.toString();
}

function responseHeader(response, name) {
  const headers = response && response.headers;
  if (!headers) return null;
  const wanted = String(name).toLowerCase();
  if (typeof headers.get === 'function') {
    const value = headers.get(wanted);
    return value == null ? null : String(value);
  }
  const value = headers[wanted] == null ? headers[name] : headers[wanted];
  return value == null ? null : String(value);
}

function responseSetCookies(response) {
  const headers = response && response.headers;
  if (!headers) return [];
  let rawValues = [];
  if (typeof headers.getSetCookie === 'function') {
    try {
      rawValues = headers.getSetCookie();
    } catch (_) {
      rawValues = [];
    }
  }
  if (!Array.isArray(rawValues) || !rawValues.length) {
    const raw = responseHeader(response, 'set-cookie');
    if (raw) rawValues = [raw];
  }
  const cookies = [];
  for (const raw of rawValues) {
    const parts = String(raw).split(/,(?=\s*[^;,=\s]+\s*=)/g);
    for (const part of parts) {
      const cookie = part.split(';', 1)[0].trim();
      if (!cookie || !/^[^=;\s,]+=[^;\r\n]*$/.test(cookie)) continue;
      cookies.push(cookie);
    }
  }
  return Array.from(new Set(cookies));
}

function asBytes(chunk) {
  if (chunk == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

async function readBodyLimited(response, limit, abortController) {
  const declared = responseHeader(response, 'content-length');
  if (declared != null && /^\d+$/.test(declared.trim()) && Number(declared) > limit) {
    if (abortController) abortController.abort();
    throw new ServiceError('UPSTREAM_TOO_LARGE', 'Upstream response too large', 502);
  }

  const chunks = [];
  let total = 0;
  const add = (chunk) => {
    const bytes = asBytes(chunk);
    total += bytes.length;
    if (total > limit) {
      if (abortController) abortController.abort();
      throw new ServiceError('UPSTREAM_TOO_LARGE', 'Upstream response too large', 502);
    }
    chunks.push(bytes);
  };

  const body = response && response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        add(part.value);
      }
    } catch (error) {
      try { await reader.cancel(); } catch (_) { /* best effort */ }
      throw error;
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    try {
      for await (const part of body) add(part);
    } catch (error) {
      throw error;
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  if (response && typeof response.text === 'function') {
    const text = await response.text();
    add(text);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (response && typeof response.json === 'function') {
    const parsed = await response.json();
    const text = JSON.stringify(parsed);
    add(text);
    return text;
  }
  throw new ServiceError('UPSTREAM_DATA', 'Invalid upstream response', 502);
}

function abortError(signal) {
  if (signal && signal.reason instanceof ServiceError) return signal.reason;
  return new ServiceError('REQUEST_DEADLINE', 'Request deadline exceeded', 504);
}

async function requestUpstream(url, expectedHost, headers, context, options) {
  const target = outboundUrl(url, expectedHost);
  if (typeof context.fetch !== 'function') {
    throw new ServiceError('UPSTREAM_FAILED', 'Upstream request failed', 502);
  }
  const settings = options || {};
  const allowedStatus = settings.allowedStatus || ((status) => status >= 200 && status < 300);
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId;
  let parentListener;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ServiceError('UPSTREAM_TIMEOUT', 'Upstream request timed out', 504));
    }, context.upstreamTimeoutMs);
  });
  const parentPromise = new Promise((_, reject) => {
    parentListener = () => {
      controller.abort();
      reject(abortError(context.signal));
    };
    if (context.signal.aborted) parentListener();
    else context.signal.addEventListener('abort', parentListener, { once: true });
  });
  const fetchPromise = Promise.resolve().then(() => context.fetch(target, {
    method: 'GET',
    headers: Object.assign({ 'User-Agent': USER_AGENT }, headers || {}),
    redirect: 'error',
    signal: controller.signal
  }));

  try {
    const response = await Promise.race([fetchPromise, timeoutPromise, parentPromise]);
    if (!response || typeof response !== 'object') {
      throw new ServiceError('UPSTREAM_DATA', 'Invalid upstream response', 502);
    }
    const status = Number(response.status);
    const hasRedirectLocation = responseHeader(response, 'location') != null;
    if (response.redirected === true || (Number.isInteger(status) && status >= 300 && status < 400) || hasRedirectLocation) {
      throw new ServiceError('UPSTREAM_REDIRECT', 'Upstream redirect rejected', 502);
    }
    if (response.url) {
      let returned;
      try { returned = new URL(response.url); } catch (_) {
        throw new ServiceError('UPSTREAM_REDIRECT', 'Upstream redirect rejected', 502);
      }
      if (returned.protocol !== 'https:' || returned.hostname !== expectedHost || returned.port !== '') {
        throw new ServiceError('UPSTREAM_REDIRECT', 'Upstream redirect rejected', 502);
      }
    }
    if (!Number.isInteger(status) || !allowedStatus(status)) {
      throw new ServiceError('UPSTREAM_HTTP', 'Upstream request failed', 502, status || null);
    }
    // JSON callers read the body by default. The Yahoo cookie bootstrap opts
    // out explicitly with readBody: false because it only needs Set-Cookie.
    if (settings.readBody === false) return { response, text: null };
    const text = await Promise.race([
      readBodyLimited(response, context.bodyLimitBytes, controller),
      timeoutPromise,
      parentPromise
    ]);
    return { response, text };
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    if (context.signal.aborted) throw abortError(context.signal);
    if (timedOut || controller.signal.aborted) {
      throw new ServiceError('UPSTREAM_TIMEOUT', 'Upstream request timed out', 504);
    }
    throw new ServiceError('UPSTREAM_FAILED', 'Upstream request failed', 502);
  } finally {
    clearTimeout(timeoutId);
    if (parentListener) context.signal.removeEventListener('abort', parentListener);
  }
}

async function fetchJson(url, expectedHost, headers, context, options) {
  const result = await requestUpstream(url, expectedHost, headers, context, options);
  try {
    return JSON.parse(result.text);
  } catch (_) {
    throw new ServiceError('UPSTREAM_DATA', 'Invalid upstream response', 502);
  }
}

async function fetchText(url, expectedHost, headers, context, options) {
  const result = await requestUpstream(url, expectedHost, headers, context, options);
  return result.text == null ? '' : result.text;
}

function chartError(data) {
  const error = data && data.chart && data.chart.error;
  return error && typeof error === 'object' ? 'No data' : null;
}

function extendedPrice(result) {
  const meta = result && result.meta ? result.meta : {};
  const timestamps = Array.isArray(result && result.timestamp) ? result.timestamp : [];
  const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
  const closes = quote && Array.isArray(quote.close) ? quote.close : [];
  const periods = meta.currentTradingPeriod || {};
  const regular = periods.regular || {};
  const regularStart = numberOrNull(regular.start);
  const regularEnd = numberOrNull(regular.end);
  let price = null;
  let timestamp = null;
  for (let index = closes.length - 1; index >= 0; index -= 1) {
    const close = numberOrNull(closes[index]);
    const time = numberOrNull(timestamps[index]);
    if (close != null && time != null) {
      price = close;
      timestamp = time;
      break;
    }
  }
  if (price != null && timestamp != null) {
    if (regularStart != null && timestamp < regularStart) return { kind: 'pre', price };
    if (regularEnd != null && timestamp >= regularEnd) return { kind: 'post', price };
  }
  if (meta.postMarketPrice != null) return { kind: 'post', price: numberOrNull(meta.postMarketPrice) };
  if (meta.preMarketPrice != null) return { kind: 'pre', price: numberOrNull(meta.preMarketPrice) };
  return { kind: null, price: null };
}

function parseQuote(data, symbol, now) {
  if (chartError(data)) throw new ServiceError('UPSTREAM_DATA', 'No data', 502);
  const result = data && data.chart && Array.isArray(data.chart.result) ? data.chart.result[0] : null;
  if (!result || !result.meta) throw new ServiceError('UPSTREAM_DATA', 'No data', 502);
  const meta = result.meta;
  const price = numberOrNull(meta.regularMarketPrice);
  const previousClose = numberOrNull(meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose);
  const change = price != null && previousClose != null ? price - previousClose : null;
  const changePct = change != null && previousClose ? (change / previousClose) * 100 : null;
  const extended = extendedPrice(result);
  return {
    symbol: meta.symbol || symbol,
    price,
    previousClose,
    change,
    changePct,
    dayLow: numberOrNull(meta.regularMarketDayLow),
    dayHigh: numberOrNull(meta.regularMarketDayHigh),
    week52Low: numberOrNull(meta.fiftyTwoWeekLow),
    week52High: numberOrNull(meta.fiftyTwoWeekHigh),
    volume: numberOrNull(meta.regularMarketVolume),
    currency: meta.currency || null,
    marketState: meta.marketState || null,
    extendedKind: extended.kind,
    extendedPrice: extended.price,
    extendedChange: extended.price != null && price != null ? extended.price - price : null,
    extendedChangePct: extended.price != null && price ? ((extended.price - price) / price) * 100 : null,
    shortName: meta.shortName || meta.longName || meta.instrumentType || symbol,
    exchange: meta.exchangeName || meta.fullExchangeName || meta.exchange || null,
    fetchedAt: new Date(now()).toISOString()
  };
}

function parseHistory(data, symbol) {
  const result = data && data.chart && Array.isArray(data.chart.result) ? data.chart.result[0] : null;
  if (!result || !Array.isArray(result.timestamp)) throw new ServiceError('UPSTREAM_DATA', 'No data', 502);
  const indicators = result.indicators || {};
  const adjusted = indicators.adjclose && indicators.adjclose[0] && indicators.adjclose[0].adjclose;
  const raw = indicators.quote && indicators.quote[0] && indicators.quote[0].close;
  const adjustedUsable = Array.isArray(adjusted) && adjusted.some((value) => numberOrNull(value) != null);
  const closes = adjustedUsable ? adjusted : (Array.isArray(raw) ? raw : []);
  const points = [];
  result.timestamp.forEach((value, index) => {
    const timestamp = numberOrNull(value);
    const close = numberOrNull(closes[index]);
    if (timestamp == null || close == null) return;
    points.push({ t: timestamp * 1000, c: Number(close.toFixed(4)) });
  });
  return {
    ccy: result.meta && result.meta.currency ? result.meta.currency : 'USD',
    points
  };
}

function parseFundamentals(data, symbol, now) {
  const result = data && data.quoteSummary && Array.isArray(data.quoteSummary.result)
    ? data.quoteSummary.result[0]
    : null;
  if (!result) throw new ServiceError('UPSTREAM_DATA', 'No data', 502);
  const summary = result.summaryDetail || {};
  const statistics = result.defaultKeyStatistics || {};
  const price = result.price || {};
  return {
    symbol,
    trailingPE: rawNumber(summary.trailingPE),
    forwardPE: rawNumber(summary.forwardPE) != null ? rawNumber(summary.forwardPE) : rawNumber(statistics.forwardPE),
    priceToBook: rawNumber(statistics.priceToBook),
    marketCap: rawNumber(price.marketCap) != null ? rawNumber(price.marketCap) : rawNumber(summary.marketCap),
    beta: rawNumber(summary.beta) != null ? rawNumber(summary.beta) : rawNumber(statistics.beta),
    payoutRatio: rawNumber(summary.payoutRatio),
    dividendRate: rawNumber(summary.dividendRate),
    sma50: rawNumber(summary.fiftyDayAverage),
    sma200: rawNumber(summary.twoHundredDayAverage),
    currency: price.currency || null,
    fetchedAt: new Date(now()).toISOString()
  };
}

function yahooChartUrl(symbol, historyRange) {
  const encoded = encodeURIComponent(symbol);
  if (historyRange) {
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=${historyRange}`;
  }
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=5m&range=1d&includePrePost=true`;
}

function yahooFundamentalsUrl(symbol, crumb) {
  return `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price%2CsummaryDetail%2CdefaultKeyStatistics&crumb=${encodeURIComponent(crumb)}`;
}

function coinGeckoUrl(ids) {
  return `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=${encodeURIComponent('sgd,usd')}&include_24hr_change=true&include_last_updated_at=true`;
}

function yahooCrumbHeaders(cookie) {
  return Object.assign({}, JSON_HEADERS, { Cookie: cookie });
}

function yahooHeaders() {
  return Object.assign({}, JSON_HEADERS);
}

function createRequestContext(fetchImpl, now, options, limiter) {
  const controller = new AbortController();
  const deadlineError = new ServiceError('REQUEST_DEADLINE', 'Request deadline exceeded', 504);
  const deadlineId = setTimeout(() => controller.abort(deadlineError), options.requestDeadlineMs);
  return {
    fetch: fetchImpl,
    now,
    signal: controller.signal,
    upstreamTimeoutMs: options.upstreamTimeoutMs,
    bodyLimitBytes: options.bodyLimitBytes,
    limiter,
    cacheLimit: options.cacheLimit,
    close: () => clearTimeout(deadlineId)
  };
}

async function loadQuote(symbol, context, cache) {
  const timestamp = context.now();
  const hit = cacheRead(cache, symbol, timestamp, QUOTE_TTL_MS);
  if (hit) return { ok: true, value: hit };
  try {
    const data = await fetchJson(yahooChartUrl(symbol), 'query1.finance.yahoo.com', yahooHeaders(), context);
    const value = parseQuote(data, symbol, context.now);
    cacheWrite(cache, symbol, value, context.now(), QUOTE_TTL_MS, context.cacheLimit);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, value: { symbol, error: publicUpstreamError(error) }, error };
  }
}

async function getYahooCrumb(context, cache, forceFresh) {
  const timestamp = context.now();
  if (!forceFresh) {
    const cached = cacheRead(cache, 'crumb', timestamp, CRUMB_TTL_MS);
    if (cached) return cached;
  }
  const session = await requestUpstream(
    'https://fc.yahoo.com',
    'fc.yahoo.com',
    yahooHeaders(),
    context,
    { readBody: false, allowedStatus: (status) => status === 200 || status === 404 }
  );
  const cookies = responseSetCookies(session.response);
  if (!cookies.length) throw new ServiceError('COOKIE', 'Yahoo session unavailable', 502);
  const cookie = cookies.join('; ');
  const crumbText = (await fetchText(
    'https://query1.finance.yahoo.com/v1/test/getcrumb',
    'query1.finance.yahoo.com',
    yahooCrumbHeaders(cookie),
    context
  )).trim();
  if (!crumbText || crumbText.includes('<') || crumbText.length > 256 || /[\r\n]/.test(crumbText)) {
    throw new ServiceError('CRUMB', 'Yahoo crumb unavailable', 502);
  }
  const pair = { cookie, crumb: crumbText };
  cacheWrite(cache, 'crumb', pair, context.now(), CRUMB_TTL_MS, context.cacheLimit);
  return pair;
}

async function loadFundamental(symbol, pair, context, cache) {
  const timestamp = context.now();
  const hit = cacheRead(cache, symbol, timestamp, FUNDAMENTALS_TTL_MS);
  if (hit) return { ok: true, value: hit, fromCache: true };
  try {
    const data = await fetchJson(
      yahooFundamentalsUrl(symbol, pair.crumb),
      'query1.finance.yahoo.com',
      yahooCrumbHeaders(pair.cookie),
      context
    );
    const value = parseFundamentals(data, symbol, context.now);
    cacheWrite(cache, symbol, value, context.now(), FUNDAMENTALS_TTL_MS, context.cacheLimit);
    return { ok: true, value, fromCache: false };
  } catch (error) {
    return { ok: false, value: { symbol, error: publicUpstreamError(error) }, error, fromCache: false };
  }
}

async function loadHistory(symbol, range, context, cache) {
  const key = `${symbol}\u0000${range}`;
  const hit = cacheRead(cache, key, context.now(), HISTORY_TTL_MS);
  if (hit) return { ok: true, value: hit };
  try {
    const data = await fetchJson(yahooChartUrl(symbol, range), 'query1.finance.yahoo.com', yahooHeaders(), context);
    const value = parseHistory(data, symbol);
    cacheWrite(cache, key, value, context.now(), HISTORY_TTL_MS, context.cacheLimit);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, value: { symbol, error: publicUpstreamError(error) }, error };
  }
}

async function runLimited(items, context, worker) {
  return Promise.all(items.map((item) => context.limiter.run(() => worker(item), context.signal).catch((error) => ({
    ok: false,
    value: { symbol: item, error: publicUpstreamError(error) },
    error
  }))));
}

async function processQuotes(params, context, quoteCache) {
  const results = await runLimited(params.symbols, context, (symbol) => loadQuote(symbol, context, quoteCache));
  const quotes = {};
  results.forEach((result, index) => { quotes[params.symbols[index]] = result.ok ? result.value : result.value; });
  const status = failureStatus(results);
  const payload = { quotes };
  if (status !== 200) payload.error = failureSummary(results);
  return { status, payload };
}

async function processFx(params, context, quoteCache) {
  const symbols = params.pairs.map((pair) => `${pair}=X`);
  const results = await runLimited(symbols, context, (symbol) => loadQuote(symbol, context, quoteCache));
  const rates = {};
  results.forEach((result, index) => {
    if (result.ok && result.value.price != null) {
      rates[params.pairs[index]] = { rate: result.value.price, fetchedAt: result.value.fetchedAt };
    }
  });
  const status = failureStatus(results);
  const payload = { rates };
  if (status !== 200) payload.error = failureSummary(results);
  return { status, payload };
}

async function processCrypto(params, context, cryptoCache) {
  const key = `${params.ids.slice().sort().join(',')}\u0000${params.vs}`;
  const hit = cacheRead(cryptoCache, key, context.now(), CRYPTO_TTL_MS);
  if (hit) return { status: 200, payload: hit };
  try {
    const data = await context.limiter.run(
      () => fetchJson(coinGeckoUrl(params.ids), 'api.coingecko.com', yahooHeaders(), context),
      context.signal
    );
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ServiceError('UPSTREAM_DATA', 'Invalid upstream response', 502);
    }
    const payload = { prices: data, fetchedAt: new Date(context.now()).toISOString() };
    cacheWrite(cryptoCache, key, payload, context.now(), CRYPTO_TTL_MS, context.cacheLimit);
    return { status: 200, payload };
  } catch (error) {
    const payload = { prices: {}, fetchedAt: new Date(context.now()).toISOString(), error: publicUpstreamError(error) };
    const status = error instanceof ServiceError && error.code === 'REQUEST_DEADLINE' ? 504 : 502;
    return { status, payload };
  }
}

async function processFundamentals(params, context, fundamentalCache, crumbCache) {
  const results = params.symbols.map(() => null);
  const missing = [];
  params.symbols.forEach((symbol, index) => {
    const hit = cacheRead(fundamentalCache, symbol, context.now(), FUNDAMENTALS_TTL_MS);
    if (hit) results[index] = { ok: true, value: hit, fromCache: true };
    else missing.push({ symbol, index });
  });
  if (missing.length) {
    let pair;
    try {
      pair = await getYahooCrumb(context, crumbCache, false);
    } catch (error) {
      missing.forEach(({ symbol, index }) => {
        results[index] = { ok: false, value: { symbol, error: publicUpstreamError(error) }, error };
      });
    }
    if (pair) {
      const first = await Promise.all(missing.map(({ symbol, index }) => (
        context.limiter.run(() => loadFundamental(symbol, pair, context, fundamentalCache), context.signal)
          .catch((error) => ({ ok: false, value: { symbol, error: publicUpstreamError(error) }, error }))
          .then((result) => ({ result, symbol, index }))
      )));
      first.forEach(({ result, index }) => { results[index] = result; });
      const retry = first.filter(({ result }) => !result.ok && result.error && result.error.upstreamStatus === 401);
      if (retry.length) {
        try {
          const freshPair = await getYahooCrumb(context, crumbCache, true);
          const retried = await Promise.all(retry.map(({ symbol, index }) => (
            context.limiter.run(() => loadFundamental(symbol, freshPair, context, fundamentalCache), context.signal)
              .catch((error) => ({ ok: false, value: { symbol, error: publicUpstreamError(error) }, error }))
              .then((result) => ({ result, symbol, index }))
          )));
          retried.forEach(({ result, index }) => { results[index] = result; });
        } catch (error) {
          /* Keep the original per-symbol 401 result if a single refresh fails. */
          void error;
        }
      }
    }
  }
  const safeResults = results.map((result, index) => result || ({
    ok: false,
    value: { symbol: params.symbols[index], error: 'Upstream request failed' },
    error: new ServiceError('UPSTREAM_FAILED', 'Upstream request failed', 502)
  }));
  const fundamentals = {};
  safeResults.forEach((result, index) => { fundamentals[params.symbols[index]] = result.value; });
  const status = failureStatus(safeResults);
  const payload = { fundamentals };
  if (status !== 200) payload.error = failureSummary(safeResults);
  return { status, payload };
}

async function processHistory(params, context, historyCache) {
  const results = await runLimited(params.symbols, context, (symbol) => loadHistory(symbol, params.range, context, historyCache));
  const history = {};
  results.forEach((result, index) => { history[params.symbols[index]] = result.ok ? result.value : result.value; });
  const status = failureStatus(results);
  const payload = { history };
  if (status !== 200) payload.error = failureSummary(results);
  return { status, payload };
}

function sendJson(response, status, payload, maxBytes) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (_) {
    status = 500;
    body = JSON.stringify({ error: 'Response encoding failed' });
  }
  if (byteLength(body) > maxBytes) {
    status = 500;
    body = JSON.stringify({ error: 'Response too large' });
  }
  if (response && typeof response.setHeader === 'function') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Length', String(byteLength(body)));
  }
  if (response) response.statusCode = status;
  if (response && typeof response.end === 'function') response.end(body);
}

function createMarketService(options) {
  const supplied = options || {};
  const now = resolveClock(supplied.clock || supplied.now);
  const fetchImpl = typeof supplied.fetch === 'function'
    ? supplied.fetch
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const boundedPositive = (value, fallback, maximum) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
      ? Math.min(number, maximum)
      : fallback;
  };
  const config = {
    upstreamTimeoutMs: boundedPositive(supplied.upstreamTimeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS, DEFAULT_REQUEST_DEADLINE_MS),
    requestDeadlineMs: boundedPositive(supplied.requestDeadlineMs, DEFAULT_REQUEST_DEADLINE_MS, 120_000),
    bodyLimitBytes: boundedPositive(supplied.bodyLimitBytes, DEFAULT_BODY_LIMIT_BYTES, DEFAULT_BODY_LIMIT_BYTES),
    downstreamLimitBytes: boundedPositive(supplied.downstreamLimitBytes, DEFAULT_DOWNSTREAM_LIMIT_BYTES, DEFAULT_DOWNSTREAM_LIMIT_BYTES),
    rateLimit: Math.floor(boundedPositive(supplied.rateLimit, RATE_LIMIT_MAX, RATE_LIMIT_MAX)),
    rateWindowMs: boundedPositive(supplied.rateWindowMs, RATE_WINDOW_MS, 60 * 60 * 1000),
    rateMaxEntries: Math.floor(boundedPositive(supplied.rateMaxEntries, RATE_MAX_ENTRIES, RATE_MAX_ENTRIES)),
    cacheLimit: Math.floor(boundedPositive(supplied.cacheLimit, MAX_CACHE_ENTRIES, MAX_CACHE_ENTRIES))
  };
  const quoteCache = new Map();
  const fundamentalCache = new Map();
  const historyCache = new Map();
  const cryptoCache = new Map();
  const crumbCache = new Map();
  const limiter = createLimiter(MAX_CONCURRENCY);
  const rateLimiter = createRateLimiter(now, config);

  async function handler(req, response) {
    let parsed;
    try {
      parsed = parseRequestUrl(req);
    } catch (error) {
      sendJson(response, 400, { error: publicUpstreamError(error) === 'Upstream request failed' ? error.message : publicUpstreamError(error) }, config.downstreamLimitBytes);
      return;
    }
    const route = ROUTES[parsed.pathname];
    if (parsed.pathname === '/healthz') {
      if (String(req.method || 'GET').toUpperCase() !== 'GET' || requestHasBody(req) || parsed.search) {
        sendJson(response, 405, { error: 'GET without a body is required' }, config.downstreamLimitBytes);
        return;
      }
      sendJson(response, 200, { ok: true }, config.downstreamLimitBytes);
      return;
    }
    if (!route) {
      sendJson(response, 404, { error: 'Not found' }, config.downstreamLimitBytes);
      return;
    }
    if (String(req.method || 'GET').toUpperCase() !== 'GET') {
      sendJson(response, 405, { error: 'GET is required' }, config.downstreamLimitBytes);
      return;
    }
    if (requestHasBody(req)) {
      sendJson(response, 400, { error: 'Request body is not accepted' }, config.downstreamLimitBytes);
      return;
    }
    const routeName = route.name;
    if (!rateLimiter.allow(directAddress(req), routeName, now())) {
      if (response && typeof response.setHeader === 'function') response.setHeader('Retry-After', '60');
      sendJson(response, 429, { error: 'Rate limit exceeded' }, config.downstreamLimitBytes);
      return;
    }
    let params;
    try {
      params = parseParams(route, parsed);
    } catch (error) {
      sendJson(response, error.status || 400, { error: error.message }, config.downstreamLimitBytes);
      return;
    }

    const context = createRequestContext(fetchImpl, now, config, limiter);
    let result;
    try {
      if (routeName === 'quotes') result = await processQuotes(params, context, quoteCache);
      else if (routeName === 'fundamentals') result = await processFundamentals(params, context, fundamentalCache, crumbCache);
      else if (routeName === 'fx') result = await processFx(params, context, quoteCache);
      else if (routeName === 'crypto') result = await processCrypto(params, context, cryptoCache);
      else result = await processHistory(params, context, historyCache);
    } catch (error) {
      const status = error instanceof ServiceError && error.code === 'REQUEST_DEADLINE' ? 504 : 502;
      result = { status, payload: { error: publicUpstreamError(error) } };
    } finally {
      context.close();
    }
    sendJson(response, result.status, result.payload, config.downstreamLimitBytes);
  }

  return {
    handler,
    handle: handler,
    requestHandler: handler,
    clearCaches: () => cacheClear(quoteCache, fundamentalCache, historyCache, cryptoCache, crumbCache),
    constants: Object.freeze({
      PORT,
      DEFAULT_UPSTREAM_TIMEOUT_MS,
      DEFAULT_REQUEST_DEADLINE_MS,
      DEFAULT_BODY_LIMIT_BYTES,
      DEFAULT_DOWNSTREAM_LIMIT_BYTES,
      MAX_CONCURRENCY,
      MAX_QUEUE,
      MAX_CACHE_ENTRIES,
      MAX_LIST_ITEMS,
      MAX_REQUEST_URL_BYTES,
      QUOTE_TTL_MS,
      FX_TTL_MS,
      CRYPTO_TTL_MS,
      FUNDAMENTALS_TTL_MS,
      HISTORY_TTL_MS,
      CRUMB_TTL_MS,
      RATE_WINDOW_MS,
      RATE_LIMIT_MAX
    }),
    rateLimiter,
    caches: {
      quotes: quoteCache,
      fundamentals: fundamentalCache,
      history: historyCache,
      crypto: cryptoCache,
      crumb: crumbCache
    }
  };
}

function startServer(options) {
  const service = createMarketService(options);
  const server = http.createServer(service.handler);
  server.requestTimeout = DEFAULT_REQUEST_DEADLINE_MS;
  server.headersTimeout = DEFAULT_REQUEST_DEADLINE_MS + 1_000;
  server.keepAliveTimeout = 5_000;
  server.listen(PORT, '0.0.0.0');
  return server;
}

module.exports = {
  createMarketService,
  createApp: createMarketService,
  startServer,
  constants: Object.freeze({
    PORT,
    DEFAULT_UPSTREAM_TIMEOUT_MS,
    DEFAULT_REQUEST_DEADLINE_MS,
    DEFAULT_BODY_LIMIT_BYTES,
    DEFAULT_DOWNSTREAM_LIMIT_BYTES,
    MAX_CONCURRENCY,
    MAX_QUEUE,
    MAX_CACHE_ENTRIES,
    MAX_LIST_ITEMS,
    MAX_REQUEST_URL_BYTES,
    QUOTE_TTL_MS,
    FX_TTL_MS,
    CRYPTO_TTL_MS,
    FUNDAMENTALS_TTL_MS,
    HISTORY_TTL_MS,
    CRUMB_TTL_MS,
    RATE_WINDOW_MS,
    RATE_LIMIT_MAX,
    RATE_MAX_ENTRIES,
    SYMBOL_RE,
    FX_PAIR_RE,
    COIN_ID_RE,
    ALLOWED_UPSTREAM_HOSTS: Array.from(ALLOWED_UPSTREAM_HOSTS)
  })
};

if (require.main === module) startServer();
