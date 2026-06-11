/**
 * Kujira Portfolio · Portfolio Tracker — Google Sheets sync + price proxy
 *
 * One Apps Script Web App that does two jobs:
 *   1. State sync — JSON blob round-trip between the HTML app and a Google Sheet
 *   2. Price proxy — server-side fetch of Yahoo Finance + CoinGecko (browser CORS bypass)
 *
 * SETUP
 *   1. Create a blank Google Sheet
 *   2. Extensions → Apps Script
 *   3. Paste this entire file into Code.gs (replace the default)
 *   4. Save → Deploy → New deployment → Type: Web app
 *        Execute as:        Me
 *        Who has access:    Anyone
 *      Click "Deploy" and copy the Web app URL
 *   5. Open the tracker → ⚙ Settings → paste URL → Save → Pull
 *
 * Re-deployments: edit the existing deployment (Manage deployments → pencil →
 * version: New version → Deploy) so the URL stays stable.
 *
 * Endpoints (all GET except sync push, which is POST):
 *   GET   /exec                                    → state blob
 *   POST  /exec                  body: payload     → save state blob (with conflict check)
 *   GET   /exec?action=prices&symbols=AAPL,D05.SI  → Yahoo Finance quotes
 *   GET   /exec?action=fundamentals&symbols=AAPL   → Yahoo quoteSummary (PE, PB, beta, …)
 *   GET   /exec?action=crypto&ids=bitcoin&vs=sgd   → CoinGecko prices
 *   GET   /exec?action=fx&pairs=USDSGD,EURSGD      → Yahoo Finance FX rates
 *
 * Schema identifier: kujira-portfolio (prevents accidental cross-app writes).
 */

const SHEET_NAME = 'Data';
const CELL       = 'A1';
const SCHEMA     = 'kujira-portfolio';

const PRICE_CACHE_TTL_SEC = 300;

function getOrCreate_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function getSheet_() {
  const sh = getOrCreate_(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange('A1').setValue('{}');
    sh.getRange('B1').setValue('Last updated');
    sh.getRange('C1').setValue('');
    sh.setColumnWidth(1, 600);
    sh.setColumnWidth(2, 140);
    sh.setColumnWidth(3, 220);
    sh.getRange('A1:C1').setFontWeight('bold');
  }
  // Always force the timestamp cell to plain text format. Without this, Sheets
  // can auto-parse our ISO string into a Date object. String(date) then returns
  // a locale-formatted string that doesn't round-trip with the original — which
  // breaks the optimistic-concurrency check.
  sh.getRange('C1').setNumberFormat('@');
  return sh;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || '';
    if (action === 'prices') return json_(fetchYahooQuotes_(e.parameter.symbols || ''));
    if (action === 'fundamentals') return json_(fetchYahooFundamentals_(e.parameter.symbols || ''));
    if (action === 'crypto') return json_(fetchCoinGecko_(e.parameter.ids || '', e.parameter.vs || 'sgd,usd'));
    if (action === 'fx')     return json_(fetchYahooFx_(e.parameter.pairs || ''));

    const sh  = getSheet_();
    const raw = sh.getRange(CELL).getValue();
    const payload = raw ? raw.toString() : '{}';
    let parsed;
    try { parsed = JSON.parse(payload); }
    catch (_) { parsed = { schema: SCHEMA, version: 1 }; }

    // Attach the server's own timestamp so the client can use it as the
    // optimistic-concurrency token. Without this, the client falls back to
    // the blob's updatedAt — which it set itself, milliseconds before the
    // save — and that never matches C1. Result: every reload + edit
    // triggers a false-positive sync conflict.
    const savedAt = sh.getRange('C1').getValue();
    if (savedAt) parsed._savedAt = String(savedAt);

    return json_(parsed);
  } catch (err) {
    return json_({ error: err.message });
  }
}

/* Allowed top-level keys on the payload. Unknown keys are dropped silently
   so a malformed client can't pollute the sheet with arbitrary structure. */
const ALLOWED_KEYS = {
  schema:1, version:1, schemaVersion:1, appVersion:1, updatedAt:1, updatedBy:1,
  lastSeenRemoteAt:1,
  stocks:1, stockTxns:1, watchlist:1, crypto:1, realestate:1, cash:1, cashTxns:1,
  cpfBalances:1, cpfHistory:1,
  income:1, expenses:1,
  snapshots:1, categories:1, settings:1,
  _priceCache:1, changelog:1, trash:1, _meta:1
};

const MAX_BODY_BYTES   = 49500;     // Sheet cell hard limit 50000 chars
const MAX_ARRAY_LEN    = 5000;      // any one table capped — beyond is anomalous
const MAX_STRING_LEN   = 5000;      // single string field cap

function sanitisePayload_(data) {
  // Strip unknown top-level keys
  const clean = {};
  Object.keys(data || {}).forEach(k => { if (ALLOWED_KEYS[k]) clean[k] = data[k]; });
  // Hard caps on arrays — protect against accidental runaway
  ['stocks','stockTxns','watchlist','crypto','realestate','cash','cashTxns','cpfHistory','income','expenses','snapshots','changelog','trash'].forEach(t => {
    if (Array.isArray(clean[t]) && clean[t].length > MAX_ARRAY_LEN) {
      clean[t] = clean[t].slice(0, MAX_ARRAY_LEN);
    }
  });
  // Truncate any string field >5KB (defensive — the frontend already caps)
  truncateStringsDeep_(clean, MAX_STRING_LEN);
  return clean;
}

function truncateStringsDeep_(obj, cap) {
  if (!obj || typeof obj !== 'object') return;
  Object.keys(obj).forEach(k => {
    const v = obj[k];
    if (typeof v === 'string' && v.length > cap) obj[k] = v.slice(0, cap);
    else if (v && typeof v === 'object') truncateStringsDeep_(v, cap);
  });
}

function doPost(e) {
  try {
    const body = e.postData && e.postData.contents;
    if (!body) throw new Error('Empty body');
    if (body.length > MAX_BODY_BYTES) throw new Error('Payload too large (>' + MAX_BODY_BYTES + ' bytes)');

    let data;
    try { data = JSON.parse(body); }
    catch (parseErr) { throw new Error('Payload is not valid JSON'); }

    if (!data || typeof data !== 'object') throw new Error('Payload must be a JSON object');
    if (data.schema !== SCHEMA) throw new Error('Invalid payload (schema mismatch — expected ' + SCHEMA + ')');

    const sh = getSheet_();

    // Optimistic concurrency: if the client sent lastSeenRemoteAt, compare to the
    // current server stamp. Mismatch → reject so the UI can offer pull-or-force.
    // beforeunload writes omit lastSeenRemoteAt and bypass the check.
    if (data.lastSeenRemoteAt) {
      const currentRemoteAt = sh.getRange('C1').getValue();
      if (currentRemoteAt && String(currentRemoteAt) !== data.lastSeenRemoteAt) {
        return json_({
          conflict: true,
          remoteAt: String(currentRemoteAt),
          lastSeenRemoteAt: data.lastSeenRemoteAt
        });
      }
    }

    // Drop unknown keys, cap oversize arrays + strings
    const clean = sanitisePayload_(data);

    const stamp = new Date().toISOString();
    sh.getRange(CELL).setValue(JSON.stringify(clean));
    sh.getRange('C1').setValue(stamp);

    // Best-effort view sheets so the user can sanity-check raw numbers in Sheets.
    // Never blocks the sync return.
    try { refreshViews_(clean); } catch (viewErr) {
      Logger.log('refreshViews_ error: ' + viewErr.message);
    }

    return json_({ ok: true, savedAt: stamp });
  } catch (err) {
    return json_({ error: err.message });
  }
}

/* ─── Price proxy: Yahoo Finance quotes ─────────────────────────────────
   symbols param is a comma list of Yahoo tickers, e.g. AAPL,D05.SI,VOO.
   Uses the v8 chart endpoint (no auth required, same one their mobile apps
   hit). The older v7/finance/quote endpoint started returning HTTP 401
   without a crumb cookie. Cached 5 min per symbol. Requests are batched in
   parallel via UrlFetchApp.fetchAll for speed.

   includePrePost=true with a 5-minute intraday series lets us read the
   latest pre/post market trade: we take the last non-null close and classify
   it against the regular session window. Pre/post is best-effort — it only
   appears for US tickers during extended hours and may be null otherwise. */
function fetchYahooQuotes_(symbolsCsv) {
  const symbols = String(symbolsCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) return { quotes: {} };

  const cache = CacheService.getScriptCache();
  const out = {};
  const missing = [];

  symbols.forEach(s => {
    const hit = cache.get('yq:' + s);
    if (hit) {
      try { out[s] = JSON.parse(hit); return; } catch (_) {}
    }
    missing.push(s);
  });

  if (missing.length) {
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const requests = missing.map(s => ({
      url: 'https://query1.finance.yahoo.com/v8/finance/chart/' +
           encodeURIComponent(s) + '?interval=5m&range=1d&includePrePost=true',
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }
    }));

    let responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (err) {
      return { error: 'Yahoo Finance fetchAll failed: ' + err.message, partial: out };
    }

    const toCache = {};
    responses.forEach((resp, i) => {
      const symbol = missing[i];
      const code = resp.getResponseCode();
      if (code !== 200) {
        out[symbol] = { symbol: symbol, error: 'HTTP ' + code };
        return;
      }
      try {
        const j = JSON.parse(resp.getContentText());
        const r = j.chart && j.chart.result && j.chart.result[0];
        if (!r || !r.meta) {
          const errMsg = (j.chart && j.chart.error && j.chart.error.description) || 'No data';
          out[symbol] = { symbol: symbol, error: errMsg };
          return;
        }
        const m = r.meta;
        const price = m.regularMarketPrice;
        const prev  = m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose;
        const change   = (price != null && prev != null) ? (price - prev) : null;
        const changePct = (change != null && prev) ? (change / prev * 100) : null;
        const ext = extractExtendedPrice_(r);
        const entry = {
          symbol: m.symbol || symbol,
          price: price,
          previousClose: prev,
          change: change,
          changePct: changePct,
          dayLow: m.regularMarketDayLow != null ? m.regularMarketDayLow : null,
          dayHigh: m.regularMarketDayHigh != null ? m.regularMarketDayHigh : null,
          week52Low: m.fiftyTwoWeekLow != null ? m.fiftyTwoWeekLow : null,
          week52High: m.fiftyTwoWeekHigh != null ? m.fiftyTwoWeekHigh : null,
          volume: m.regularMarketVolume != null ? m.regularMarketVolume : null,
          currency: m.currency,
          marketState: m.marketState || null,
          extendedKind: ext.kind,    // 'pre' | 'post' | null
          extendedPrice: ext.price,  // latest pre/post trade, or null
          extendedChange: (ext.price != null && price != null) ? (ext.price - price) : null,
          extendedChangePct: (ext.price != null && price) ? ((ext.price - price) / price * 100) : null,
          shortName: m.shortName || m.longName || m.instrumentType || symbol,
          exchange: m.exchangeName || m.fullExchangeName || null,
          fetchedAt: new Date().toISOString()
        };
        out[symbol] = entry;
        toCache['yq:' + symbol] = JSON.stringify(entry);
      } catch (err) {
        out[symbol] = { symbol: symbol, error: err.message };
      }
    });
    if (Object.keys(toCache).length) {
      cache.putAll(toCache, PRICE_CACHE_TTL_SEC);
    }
  }

  return { quotes: out };
}

/* Pull the latest pre/post-market trade out of an intraday chart result.
   Walks the close series from the end to the last non-null point, then
   classifies its timestamp against the regular trading window. Returns
   { kind:'pre'|'post'|null, price:Number|null }. kind is null when the
   latest point sits inside regular hours (nothing extended to show). */
function extractExtendedPrice_(r) {
  const m  = r.meta || {};
  const ts = r.timestamp || [];
  const q  = r.indicators && r.indicators.quote && r.indicators.quote[0];
  const closes = (q && q.close) || [];
  const cp = m.currentTradingPeriod || {};
  const regStart = cp.regular && cp.regular.start;
  const regEnd   = cp.regular && cp.regular.end;

  let lastPrice = null, lastTs = null;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null) { lastPrice = closes[i]; lastTs = ts[i]; break; }
  }
  if (lastPrice == null || lastTs == null) return { kind: null, price: null };
  if (regStart != null && lastTs <  regStart) return { kind: 'pre',  price: lastPrice };
  if (regEnd   != null && lastTs >= regEnd)   return { kind: 'post', price: lastPrice };
  return { kind: null, price: null };
}

/* ─── Fundamentals proxy: Yahoo quoteSummary ─────────────────────────────
   symbols param is a comma list of Yahoo tickers. The v10 quoteSummary
   endpoint carries the slow-moving stats the chart meta lacks: PE, PB,
   market cap, beta, payout ratio, 50/200-day averages. Unlike v8 chart it
   is crumb-protected: hit fc.yahoo.com for a session cookie, exchange it
   for a crumb at v1/test/getcrumb, then pass both on every call. The
   cookie+crumb pair is cached 30 min, per-symbol fundamentals 6 h
   (CacheService TTL ceiling — these change daily at most). On a 401 the
   crumb is refreshed once and the failed symbols retried. Missing fields
   (ETFs have no PE) come back null and the app renders its empty token. */
const FUND_CACHE_TTL_SEC  = 21600;  // 6 h, CacheService maximum
const CRUMB_CACHE_TTL_SEC = 1800;

const YF_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function getYahooCrumb_(forceFresh) {
  const cache = CacheService.getScriptCache();
  if (!forceFresh) {
    const hit = cache.get('ycrumb');
    if (hit) { try { return JSON.parse(hit); } catch (_) {} }
  }
  // Step 1: fc.yahoo.com 404s but sets the session cookie we need.
  const r1 = UrlFetchApp.fetch('https://fc.yahoo.com', {
    muteHttpExceptions: true, followRedirects: false, headers: { 'User-Agent': YF_UA }
  });
  const rawSetCookie = r1.getAllHeaders()['Set-Cookie'];
  const cookieParts = (Array.isArray(rawSetCookie) ? rawSetCookie : [rawSetCookie])
    .filter(Boolean).map(c => String(c).split(';')[0]);
  if (!cookieParts.length) throw new Error('Yahoo did not set a session cookie');
  const cookie = cookieParts.join('; ');
  // Step 2: exchange the cookie for a crumb.
  const r2 = UrlFetchApp.fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    muteHttpExceptions: true, headers: { 'User-Agent': YF_UA, Cookie: cookie }
  });
  const crumb = r2.getContentText().trim();
  if (r2.getResponseCode() !== 200 || !crumb || crumb.indexOf('<') !== -1) {
    throw new Error('Yahoo crumb fetch failed (HTTP ' + r2.getResponseCode() + ')');
  }
  const pair = { cookie: cookie, crumb: crumb };
  cache.put('ycrumb', JSON.stringify(pair), CRUMB_CACHE_TTL_SEC);
  return pair;
}

function raw_(o) { return (o && o.raw != null) ? o.raw : null; }

function fetchYahooFundamentals_(symbolsCsv) {
  const symbols = String(symbolsCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) return { fundamentals: {} };

  const cache = CacheService.getScriptCache();
  const out = {};
  let missing = [];

  symbols.forEach(s => {
    const hit = cache.get('yf:' + s);
    if (hit) {
      try { out[s] = JSON.parse(hit); return; } catch (_) {}
    }
    missing.push(s);
  });

  if (missing.length) {
    let pair;
    try { pair = getYahooCrumb_(false); }
    catch (err) { return { error: 'Yahoo crumb: ' + err.message, fundamentals: out }; }

    const attempt = (syms, cr) => {
      const reqs = syms.map(s => ({
        url: 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' +
             encodeURIComponent(s) +
             '?modules=price,summaryDetail,defaultKeyStatistics&crumb=' +
             encodeURIComponent(cr.crumb),
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { 'User-Agent': YF_UA, 'Accept': 'application/json', Cookie: cr.cookie }
      }));
      try { return UrlFetchApp.fetchAll(reqs); }
      catch (err) { return null; }
    };

    let responses = attempt(missing, pair);
    if (!responses) return { error: 'Yahoo quoteSummary fetchAll failed', fundamentals: out };

    // Stale crumb shows up as a wall of 401s. Refresh once and retry those.
    if (responses.some(r => r.getResponseCode() === 401)) {
      try {
        pair = getYahooCrumb_(true);
        const retryIdx = [];
        responses.forEach((r, i) => { if (r.getResponseCode() === 401) retryIdx.push(i); });
        const retried = attempt(retryIdx.map(i => missing[i]), pair);
        if (retried) retryIdx.forEach((origI, k) => { responses[origI] = retried[k]; });
      } catch (_) { /* keep the 401 responses, reported per symbol below */ }
    }

    const toCache = {};
    responses.forEach((resp, i) => {
      const symbol = missing[i];
      const code = resp.getResponseCode();
      if (code !== 200) {
        out[symbol] = { symbol: symbol, error: 'HTTP ' + code };
        return;
      }
      try {
        const j = JSON.parse(resp.getContentText());
        const r = j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
        if (!r) {
          const errMsg = (j.quoteSummary && j.quoteSummary.error && j.quoteSummary.error.description) || 'No data';
          out[symbol] = { symbol: symbol, error: errMsg };
          return;
        }
        const sd = r.summaryDetail || {};
        const ks = r.defaultKeyStatistics || {};
        const pr = r.price || {};
        const entry = {
          symbol: symbol,
          trailingPE:   raw_(sd.trailingPE),
          forwardPE:    raw_(sd.forwardPE) != null ? raw_(sd.forwardPE) : raw_(ks.forwardPE),
          priceToBook:  raw_(ks.priceToBook),
          marketCap:    raw_(pr.marketCap) != null ? raw_(pr.marketCap) : raw_(sd.marketCap),
          beta:         raw_(sd.beta) != null ? raw_(sd.beta) : raw_(ks.beta),
          payoutRatio:  raw_(sd.payoutRatio),
          dividendRate: raw_(sd.dividendRate),
          sma50:        raw_(sd.fiftyDayAverage),
          sma200:       raw_(sd.twoHundredDayAverage),
          currency:     pr.currency || null,
          fetchedAt:    new Date().toISOString()
        };
        out[symbol] = entry;
        toCache['yf:' + symbol] = JSON.stringify(entry);
      } catch (err) {
        out[symbol] = { symbol: symbol, error: err.message };
      }
    });
    if (Object.keys(toCache).length) {
      cache.putAll(toCache, FUND_CACHE_TTL_SEC);
    }
  }

  return { fundamentals: out };
}

/* ─── Price proxy: CoinGecko ─────────────────────────────────────────────
   ids param is a comma list of CoinGecko coin ids, e.g. bitcoin,ethereum.
   vs param is a comma list of vs_currencies, defaults to sgd,usd.        */
function fetchCoinGecko_(idsCsv, vsCsv) {
  const ids = String(idsCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return { prices: {} };
  const vs = String(vsCsv || 'sgd,usd').split(',').map(s => s.trim()).filter(Boolean).join(',');

  const cacheKey = 'cg:' + ids.sort().join(',') + ':' + vs;
  const cache = CacheService.getScriptCache();
  const hit = cache.get(cacheKey);
  if (hit) { try { return JSON.parse(hit); } catch (_) {} }

  const url = 'https://api.coingecko.com/api/v3/simple/price' +
              '?ids=' + encodeURIComponent(ids.join(',')) +
              '&vs_currencies=' + encodeURIComponent(vs) +
              '&include_24hr_change=true&include_last_updated_at=true';
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const code = resp.getResponseCode();
    if (code !== 200) throw new Error('CoinGecko HTTP ' + code);
    const data = JSON.parse(resp.getContentText());
    const result = { prices: data, fetchedAt: new Date().toISOString() };
    cache.put(cacheKey, JSON.stringify(result), PRICE_CACHE_TTL_SEC);
    return result;
  } catch (err) {
    return { error: 'CoinGecko fetch failed: ' + err.message };
  }
}

/* ─── Price proxy: Yahoo FX ──────────────────────────────────────────────
   pairs param is a comma list of currency pairs, e.g. USDSGD,EURSGD.
   Internally hits the Yahoo quote endpoint with the =X suffix.           */
function fetchYahooFx_(pairsCsv) {
  const pairs = String(pairsCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!pairs.length) return { rates: {} };
  const symbols = pairs.map(p => p.toUpperCase() + '=X').join(',');
  const res = fetchYahooQuotes_(symbols);
  const rates = {};
  pairs.forEach(p => {
    const q = res.quotes && res.quotes[p.toUpperCase() + '=X'];
    if (q && q.price != null) rates[p.toUpperCase()] = { rate: q.price, fetchedAt: q.fetchedAt };
  });
  return { rates: rates, error: res.error };
}

/* ─── Per-table view sheets ──────────────────────────────────────────────
   One readable tab per data type so the user can audit raw values without
   opening the app. Headers stay stable across versions; new fields append
   to the right. Each write is atomic (single setValues call) — half-written
   tabs from a quota timeout are avoided. Best-effort: never throws.        */
const VIEW_SCHEMAS = {
  Stocks:        ['id','symbol','market','shares','avgCost','currency','notes','createdAt','updatedAt'],
  'Stock Trades':['id','stockId','date','side','shares','price','fees','notes','createdAt','updatedAt'],
  Crypto:        ['id','symbol','coingeckoId','amount','avgCost','currency','notes','createdAt','updatedAt'],
  'Real Estate': ['id','name','value','currency','notes','updatedAt'],
  Cash:          ['id','name','account','amount','currency','notes','updatedAt'],
  'Cash Movements':['id','type','cashAccountId','fromAccountId','date','amount','amountIn','notes','createdAt','updatedAt'],
  'CPF Balances':['account','balance','updatedAt'],
  'CPF History': ['id','date','type','account','amount','source','notes','createdAt','updatedAt'],
  Income:        ['id','date','gross','net','employerCPF','employeeCPF','source','notes','createdAt','updatedAt'],
  Expenses:      ['id','date','amount','currency','category','subcategory','merchant','notes','createdAt','updatedAt'],
  Trash:         ['id','table','ts','data'],
  Settings:      ['key','value']
};

function refreshViews_(data) {
  writeTable_('Stocks',       data.stocks);
  writeTable_('Stock Trades', sortByField_(data.stockTxns, 'date'));
  writeTable_('Crypto',       data.crypto);
  writeTable_('Real Estate',  data.realestate);
  writeTable_('Cash',         data.cash);
  writeTable_('Cash Movements', sortByField_(data.cashTxns, 'date'));
  writeCpfBalances_('CPF Balances', data.cpfBalances);
  writeTable_('CPF History',  sortByField_(data.cpfHistory, 'date'));
  writeTable_('Income',       sortByField_(data.income,    'date'));
  writeTable_('Expenses',     sortByField_(data.expenses,  'date'));
  writeTrash_('Trash',        data.trash);
  writeSettings_('Settings',  data.settings);
}

function sortByField_(arr, field) {
  if (!Array.isArray(arr)) return [];
  return arr.slice().sort((a, b) => String(b[field] || '').localeCompare(String(a[field] || '')));
}

/* Generic write: header row + body rows from schema, single setValues per. */
function writeTable_(tabName, rows) {
  const sh = getOrCreate_(tabName);
  sh.clearContents();
  const headers = VIEW_SCHEMAS[tabName];
  if (!headers) return;
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#1e1e1e').setFontColor('#e8e8e8');
  sh.setFrozenRows(1);
  if (!Array.isArray(rows) || !rows.length) {
    sh.autoResizeColumns(1, headers.length);
    return;
  }
  const body = rows.map(r => headers.map(h => {
    const v = r && r[h];
    if (v == null) return '';
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }));
  sh.getRange(2, 1, body.length, headers.length).setValues(body);
  sh.autoResizeColumns(1, headers.length);
}

/* CPF Balances is a key/value object, not an array — flatten to 4 rows. */
function writeCpfBalances_(tabName, balances) {
  const sh = getOrCreate_(tabName);
  sh.clearContents();
  const headers = VIEW_SCHEMAS[tabName];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#1e1e1e').setFontColor('#e8e8e8');
  sh.setFrozenRows(1);
  const b = balances || {};
  const ts = b.updatedAt || '';
  const rows = ['OA','SA','MA','RA'].map(acc => [acc, Number(b[acc] || 0), ts]);
  sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.autoResizeColumns(1, headers.length);
}

/* Trash entries wrap arbitrary data — stringify the inner record for display. */
function writeTrash_(tabName, rows) {
  const sh = getOrCreate_(tabName);
  sh.clearContents();
  const headers = VIEW_SCHEMAS[tabName];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#1e1e1e').setFontColor('#e8e8e8');
  sh.setFrozenRows(1);
  if (!Array.isArray(rows) || !rows.length) return;
  const body = rows.map(r => [r.id || '', r.table || '', r.ts || '', JSON.stringify(r.data || {})]);
  sh.getRange(2, 1, body.length, headers.length).setValues(body);
  sh.autoResizeColumns(1, headers.length);
}

/* Settings is one key/value pair per row, including nested objects (CPF rates, FX) */
function writeSettings_(tabName, settings) {
  const sh = getOrCreate_(tabName);
  sh.clearContents();
  const headers = VIEW_SCHEMAS[tabName];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#1e1e1e').setFontColor('#e8e8e8');
  sh.setFrozenRows(1);
  const s = settings || {};
  const rows = [];
  const flatten = (prefix, obj) => {
    Object.keys(obj || {}).forEach(k => {
      const v = obj[k];
      if (v != null && typeof v === 'object' && !Array.isArray(v)) {
        flatten(prefix + k + '.', v);
      } else {
        rows.push([prefix + k, Array.isArray(v) ? JSON.stringify(v) : (v == null ? '' : String(v))]);
      }
    });
  };
  flatten('', s);
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.autoResizeColumns(1, headers.length);
}

/** Run once after pasting to grant scopes (Sheets + UrlFetch + Cache). */
function initOnce() {
  const sh = getSheet_();
  Logger.log('Initialised sheet: ' + sh.getName());
  Logger.log('Schema: ' + SCHEMA);
  const test = fetchYahooQuotes_('AAPL');
  Logger.log('Yahoo test: ' + JSON.stringify(test));
}
