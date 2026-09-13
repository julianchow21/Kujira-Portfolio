'use strict';

/*
 * Market proxy tests use only in-process mocked fetch responses. No upstream
 * network, Docker runtime, real account, or real market data is involved.
 */
const assert = require('assert');
const {
  createMarketService,
  constants
} = require('../NAS/Market Service.js');

let checks = 0;
function check(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}
function equal(actual, expected, message) {
  checks += 1;
  assert.deepStrictEqual(actual, expected, message);
}

function responseHeaders(entries) {
  const values = new Map(Object.entries(entries || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    get(name) { return values.get(String(name).toLowerCase()) || null; },
    getSetCookie() { return []; }
  };
}

function jsonResponse(value, options) {
  const settings = options || {};
  const text = settings.text == null ? JSON.stringify(value) : String(settings.text);
  const entries = Object.assign({}, settings.headers || {});
  if (settings.contentLength) entries['content-length'] = String(settings.contentLength);
  const headers = responseHeaders(entries);
  if (Array.isArray(settings.setCookies)) headers.getSetCookie = () => settings.setCookies.slice();
  return {
    status: settings.status == null ? 200 : settings.status,
    url: settings.url,
    redirected: settings.redirected === true,
    headers,
    body: settings.body || null,
    async text() { return text; }
  };
}

function request(url, options) {
  const settings = options || {};
  const headers = Object.assign({}, settings.headers || {});
  const req = {
    method: settings.method || 'GET',
    url,
    headers,
    socket: { remoteAddress: settings.ip || '198.51.100.7' }
  };
  if (Object.prototype.hasOwnProperty.call(settings, 'body')) req.body = settings.body;
  return req;
}

async function call(service, url, options) {
  const result = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); },
    end(body) { this.body = body == null ? '' : String(body); }
  };
  await service.handler(request(url, options), result);
  check(result.headers['content-type'] === 'application/json; charset=utf-8', `${url} must return JSON`);
  check(result.body != null, `${url} must end with a body`);
  let json;
  assert.doesNotThrow(() => { json = JSON.parse(result.body); }, `${url} returned invalid JSON`);
  return { status: result.statusCode, headers: result.headers, body: result.body, json };
}

function chartPayload(symbol, options) {
  const settings = options || {};
  return {
    chart: {
      error: null,
      result: [{
        meta: Object.assign({
          symbol,
          regularMarketPrice: 100,
          chartPreviousClose: 90,
          regularMarketDayLow: 95,
          regularMarketDayHigh: 105,
          fiftyTwoWeekLow: 60,
          fiftyTwoWeekHigh: 120,
          regularMarketVolume: 1234,
          currency: 'USD',
          marketState: 'REGULAR',
          shortName: 'Synthetic asset',
          exchangeName: 'Synthetic Exchange'
        }, settings.meta || {}),
        timestamp: settings.timestamp || [1700000000, 1700000300],
        indicators: {
          quote: [{ close: settings.closes || [99, 101] }],
          adjclose: settings.adjusted ? [{ adjclose: settings.adjusted }] : undefined
        }
      }]
    }
  };
}

async function main() {
  equal(constants.PORT, 8081, 'service port must stay internal 8081');
  equal(constants.DEFAULT_UPSTREAM_TIMEOUT_MS, 8_000, 'upstream timeout must be 8 seconds');
  equal(constants.DEFAULT_REQUEST_DEADLINE_MS, 20_000, 'request deadline must be 20 seconds');
  equal(constants.DEFAULT_BODY_LIMIT_BYTES, 512 * 1024, 'upstream body cap must be 512 KiB');
  equal(constants.DEFAULT_DOWNSTREAM_LIMIT_BYTES, 1 * 1024 * 1024, 'downstream body cap must be 1 MiB');
  equal(constants.MAX_CONCURRENCY, 8, 'upstream concurrency must be eight');
  equal(constants.RATE_WINDOW_MS, 60 * 1000, 'rate window must be one minute');
  equal(constants.RATE_LIMIT_MAX, 120, 'rate limit default must be bounded');
  equal(constants.ALLOWED_UPSTREAM_HOSTS.sort(), [
    'api.coingecko.com',
    'fc.yahoo.com',
    'query1.finance.yahoo.com'
  ], 'upstream host allowlist must be exact');

  const quoteCalls = [];
  const quoteService = createMarketService({
    now: () => 1700000000000,
    fetch: async (url, init) => {
      quoteCalls.push({ url, init });
      return jsonResponse(chartPayload('AAPL', {
        meta: {
          currentTradingPeriod: {
            regular: { start: 1700000000, end: 1700000200 }
          }
        },
        timestamp: [1700000000, 1700000300],
        closes: [99, 101]
      }), { url });
    }
  });
  const quote = await call(quoteService, '/market/v1/quotes?symbols=AAPL');
  equal(quote.status, 200, 'quotes should return HTTP 200');
  equal(quote.json.quotes.AAPL.symbol, 'AAPL', 'quote symbol must match Apps Script shape');
  equal(quote.json.quotes.AAPL.price, 100, 'quote price must be preserved');
  equal(quote.json.quotes.AAPL.previousClose, 90, 'previous close must be preserved');
  equal(quote.json.quotes.AAPL.change, 10, 'quote change must be calculated');
  equal(quote.json.quotes.AAPL.extendedKind, 'post', 'latest post-market point must be classified');
  equal(quote.json.quotes.AAPL.extendedPrice, 101, 'latest extended price must be preserved');
  equal(quoteCalls.length, 1, 'one quote should make one upstream request');
  equal(quoteCalls[0].url, 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=5m&range=1d&includePrePost=true', 'quote URL must be fixed');
  equal(quoteCalls[0].init.method, 'GET', 'upstream method must be GET');
  equal(quoteCalls[0].init.redirect, 'error', 'upstream redirects must be rejected');
  check(quoteCalls[0].init.headers['User-Agent'], 'upstream request must identify the service');

  const cachedQuote = await call(quoteService, '/market/v1/quotes?symbols=AAPL');
  equal(cachedQuote.json.quotes.AAPL.price, 100, 'cached quote must retain the payload');
  equal(quoteCalls.length, 1, 'quote TTL must avoid a second upstream request');

  const historyCalls = [];
  const historyService = createMarketService({
    fetch: async (url) => {
      historyCalls.push(url);
      return jsonResponse(chartPayload('MSFT', {
        meta: { currency: 'USD' },
        timestamp: [1700000000, 1700086400],
        closes: [9, 10],
        adjusted: [8.5, 9.5]
      }), { url });
    }
  });
  const history = await call(historyService, '/market/v1/history?symbols=MSFT&range=1y');
  equal(history.status, 200, 'history should return HTTP 200');
  equal(history.json.history.MSFT.ccy, 'USD', 'history currency must match Apps Script shape');
  equal(history.json.history.MSFT.points, [{ t: 1700000000000, c: 8.5 }, { t: 1700086400000, c: 9.5 }], 'history should prefer adjusted close points');
  equal(historyCalls[0], 'https://query1.finance.yahoo.com/v8/finance/chart/MSFT?interval=1d&range=1y', 'history URL must be fixed');

  const fxCalls = [];
  const fxService = createMarketService({
    fetch: async (url) => {
      fxCalls.push(url);
      return jsonResponse(chartPayload('USDSGD=X', {
        meta: { symbol: 'USDSGD=X', regularMarketPrice: 1.34, chartPreviousClose: 1.33, currency: 'SGD' }
      }), { url });
    }
  });
  const fx = await call(fxService, '/market/v1/fx?pairs=USDSGD');
  equal(fx.json.rates.USDSGD.rate, 1.34, 'FX response must preserve the rate shape');
  equal(fxCalls[0], 'https://query1.finance.yahoo.com/v8/finance/chart/USDSGD%3DX?interval=5m&range=1d&includePrePost=true', 'FX must use the fixed Yahoo host');

  const cryptoCalls = [];
  const cryptoService = createMarketService({
    fetch: async (url) => {
      cryptoCalls.push(url);
      return jsonResponse({
        bitcoin: { sgd: 90000, usd: 65000, sgd_24h_change: 1.2 },
        ethereum: { sgd: 4000, usd: 2900, usd_24h_change: -0.4 }
      }, { url });
    }
  });
  const crypto = await call(cryptoService, '/market/v1/crypto?ids=bitcoin,ethereum&vs=sgd,usd');
  equal(crypto.json.prices.bitcoin.sgd, 90000, 'crypto response must preserve CoinGecko prices');
  equal(cryptoCalls[0], 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin%2Cethereum&vs_currencies=sgd%2Cusd&include_24hr_change=true&include_last_updated_at=true', 'crypto must use the fixed CoinGecko host');
  equal((await call(cryptoService, '/market/v1/crypto?ids=ethereum,bitcoin&vs=sgd,usd')).json.prices.ethereum.sgd, 4000, 'crypto cache key should be order independent');
  equal(cryptoCalls.length, 1, 'crypto TTL should avoid a second upstream request');

  const fundamentalCalls = [];
  const fundamentalService = createMarketService({
    fetch: async (url, init) => {
      fundamentalCalls.push({ url, init });
      if (url === 'https://fc.yahoo.com/') {
        return jsonResponse({}, { status: 404, url, setCookies: ['session=synthetic-cookie; Path=/; Secure'] });
      }
      if (url === 'https://query1.finance.yahoo.com/v1/test/getcrumb') {
        return jsonResponse({}, { url, text: 'synthetic-crumb' });
      }
      return jsonResponse({
        quoteSummary: {
          result: [{
            price: { marketCap: { raw: 1230000000 }, currency: 'USD' },
            summaryDetail: { trailingPE: { raw: 20 }, beta: { raw: 1.1 }, fiftyDayAverage: { raw: 98 } },
            defaultKeyStatistics: { priceToBook: { raw: 3.2 }, twoHundredDayAverage: { raw: 88 } }
          }]
        }
      }, { url });
    }
  });
  const fundamentals = await call(fundamentalService, '/market/v1/fundamentals?symbols=AAPL');
  equal(fundamentals.json.fundamentals.AAPL.trailingPE, 20, 'fundamentals must preserve Apps Script fields');
  equal(fundamentals.json.fundamentals.AAPL.marketCap, 1230000000, 'fundamentals market cap must be numeric');
  equal(fundamentalCalls.length, 3, 'fundamentals should obtain cookie, crumb, and data');
  equal(fundamentalCalls[2].init.headers.Cookie, 'session=synthetic-cookie', 'Yahoo cookie must stay on the upstream request');
  check(!fundamentals.body.includes('synthetic-cookie') && !fundamentals.body.includes('synthetic-crumb'), 'Yahoo session material must never reach the response');

  const invalidService = createMarketService({ fetch: async () => jsonResponse(chartPayload('AAPL')) });
  equal((await call(invalidService, '/nope')).status, 404, 'unknown route must be JSON 404');
  equal((await call(invalidService, '/market/v1/quotes?symbols=AAPL', { method: 'POST' })).status, 405, 'non-GET must be rejected');
  equal((await call(invalidService, '/market/v1/quotes?symbols=AAPL', { headers: { 'content-length': '1' } })).status, 400, 'request bodies must be rejected');
  equal((await call(invalidService, '/market/v1/quotes')).status, 400, 'missing query parameters must be rejected');
  equal((await call(invalidService, '/market/v1/quotes?symbols=AAPL&extra=x')).status, 400, 'unknown query parameters must be rejected');
  equal((await call(invalidService, '/market/v1/quotes?symbols=AAPL&symbols=MSFT')).status, 400, 'duplicate query parameters must be rejected');
  equal((await call(invalidService, '/market/v1/quotes?symbols=AAPL%2Cbad%20symbol')).status, 400, 'invalid symbols must be rejected');
  equal((await call(invalidService, '/market/v1/crypto?ids=Bitcoin&vs=sgd,usd')).status, 400, 'CoinGecko ids must be canonical lowercase ids');
  equal((await call(invalidService, '/healthz')).json, { ok: true }, 'health endpoint must be a JSON GET response');
  equal((await call(invalidService, '/healthz', { method: 'POST' })).status, 405, 'health endpoint must be GET-only');

  const redirectService = createMarketService({
    fetch: async (url) => jsonResponse({}, { status: 301, url, headers: { location: 'https://evil.invalid' } })
  });
  const redirect = await call(redirectService, '/market/v1/quotes?symbols=AAPL');
  equal(redirect.status, 502, 'upstream redirects must map to a gateway error');
  equal(redirect.json.quotes.AAPL.error, 'Upstream redirect rejected', 'redirect error must be safe and explicit');

  const wrongHostService = createMarketService({
    fetch: async (url) => jsonResponse({}, { url: 'https://evil.invalid/data' })
  });
  equal((await call(wrongHostService, '/market/v1/quotes?symbols=AAPL')).json.quotes.AAPL.error, 'Upstream redirect rejected', 'unexpected upstream response host must be rejected');

  const wrongPortService = createMarketService({
    fetch: async () => jsonResponse({}, { url: 'https://query1.finance.yahoo.com:8443/data' })
  });
  equal((await call(wrongPortService, '/market/v1/quotes?symbols=AAPL')).json.quotes.AAPL.error, 'Upstream redirect rejected', 'unexpected upstream response port must be rejected');

  const tooLargeService = createMarketService({
    bodyLimitBytes: 10,
    fetch: async (url) => jsonResponse({}, { url, text: '01234567890', contentLength: 11 })
  });
  const tooLarge = await call(tooLargeService, '/market/v1/quotes?symbols=AAPL');
  equal(tooLarge.status, 502, 'oversized upstream data must fail safely');
  equal(tooLarge.json.quotes.AAPL.error, 'Upstream response too large', 'upstream cap error must be public-safe');

  const downstreamService = createMarketService({
    downstreamLimitBytes: 20,
    fetch: async (url) => jsonResponse(chartPayload('AAPL'), { url })
  });
  const downstream = await call(downstreamService, '/market/v1/quotes?symbols=AAPL');
  equal(downstream.status, 500, 'oversized downstream data must not be emitted');
  equal(downstream.json, { error: 'Response too large' }, 'downstream cap must return bounded JSON');

  const timeoutService = createMarketService({
    upstreamTimeoutMs: 5,
    requestDeadlineMs: 100,
    fetch: async () => new Promise(() => {})
  });
  const timeout = await call(timeoutService, '/market/v1/quotes?symbols=AAPL');
  equal(timeout.status, 504, 'upstream timeout must return 504');
  equal(timeout.json.quotes.AAPL.error, 'Upstream request timed out', 'timeout message must be public-safe');

  const deadlineService = createMarketService({
    upstreamTimeoutMs: 100,
    requestDeadlineMs: 5,
    fetch: async () => new Promise(() => {})
  });
  const deadline = await call(deadlineService, '/market/v1/quotes?symbols=AAPL');
  equal(deadline.status, 504, 'request deadline must return 504');
  equal(deadline.json.quotes.AAPL.error, 'Request deadline exceeded', 'deadline message must be public-safe');

  let now = 1700000000000;
  let ttlCalls = 0;
  const ttlService = createMarketService({
    clock: () => now,
    fetch: async (url) => {
      ttlCalls += 1;
      return jsonResponse(chartPayload('TTL'), { url });
    }
  });
  await call(ttlService, '/market/v1/quotes?symbols=TTL');
  now += constants.QUOTE_TTL_MS - 1;
  await call(ttlService, '/market/v1/quotes?symbols=TTL');
  equal(ttlCalls, 1, 'quote cache should remain valid before its TTL');
  now += 1;
  await call(ttlService, '/market/v1/quotes?symbols=TTL');
  equal(ttlCalls, 2, 'quote cache should expire at its TTL');

  let active = 0;
  let maximum = 0;
  const concurrentService = createMarketService({
    fetch: async (url) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
      const symbol = decodeURIComponent(new URL(url).pathname.split('/').pop());
      return jsonResponse(chartPayload(symbol), { url });
    }
  });
  const symbols = Array.from({ length: 10 }, (_, index) => `SYM${index}`);
  const concurrent = await call(concurrentService, `/market/v1/quotes?symbols=${symbols.join(',')}`);
  equal(concurrent.status, 200, 'concurrent quote batch should succeed');
  check(maximum <= constants.MAX_CONCURRENCY, 'upstream concurrency must not exceed eight');
  equal(Object.keys(concurrent.json.quotes).length, 10, 'concurrent quote batch must preserve every symbol');

  const rateService = createMarketService({
    rateLimit: 2,
    rateWindowMs: 60_000,
    rateMaxEntries: 2,
    fetch: async (url) => jsonResponse(chartPayload('RATE'), { url })
  });
  equal((await call(rateService, '/market/v1/quotes?symbols=RATE', { ip: '203.0.113.5' })).status, 200, 'first rate-limited request should pass');
  equal((await call(rateService, '/market/v1/quotes?symbols=RATE', { ip: '203.0.113.5' })).status, 200, 'second rate-limited request should pass');
  const limited = await call(rateService, '/market/v1/quotes?symbols=RATE', { ip: '203.0.113.5' });
  equal(limited.status, 429, 'third request from one IP and route must be rate limited');
  equal(limited.headers['retry-after'], '60', 'rate limiting must provide a bounded retry hint');
  equal((await call(rateService, '/market/v1/quotes?symbols=RATE', { ip: '203.0.113.6' })).status, 200, 'rate limit must be keyed by direct IP');
  equal((await call(rateService, '/market/v1/quotes?symbols=RATE', { ip: '203.0.113.7' })).status, 200, 'a new direct IP may use an evicted rate bucket');
  check(rateService.rateLimiter.size <= 2, 'rate limiter entry storage must stay bounded');

  console.log(`Market service tests passed (${checks} assertions)`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
