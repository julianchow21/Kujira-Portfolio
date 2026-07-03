/* Release consistency check (Docs/Premium Mobile & Enterprise Plan v1, A4).
   Node, zero dependencies. Catches the "shipped stale code to returning
   visitors" class of bug: index.html's script tags, sw.js's pre-cache list,
   and app.js's version constants must all agree, every deploy, or a returning
   visitor's service worker keeps serving an old app.js forever.
   Path-resolved via __dirname so it runs from any cwd (repo root, Portfolio/,
   CI). Exits non-zero with a clear message naming the mismatched values. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML_PATH = path.join(ROOT, 'index.html');
const SW_JS_PATH = path.join(ROOT, 'sw.js');
const APP_JS_PATH = path.join(ROOT, 'Worker', 'app.js');

let failures = 0;
function fail(msg) {
  console.error('FAIL: ' + msg);
  failures++;
}
function pass(msg) {
  console.log('PASS: ' + msg);
}

const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const swJs = fs.readFileSync(SW_JS_PATH, 'utf8');
const appJs = fs.readFileSync(APP_JS_PATH, 'utf8');

/* ─── 1. Every local <script src> in index.html appears verbatim in sw.js
   CORE_ASSETS. "Local" excludes absolute URLs (the Chart.js CDN tag), which
   sw.js tracks separately as CHART_JS_URL. ────────────────────────────── */
(function checkScriptTags() {
  const scriptSrcRe = /<script\s+[^>]*src=["']([^"']+)["'][^>]*>/g;
  const localSrcs = [];
  let m;
  while ((m = scriptSrcRe.exec(indexHtml))) {
    const src = m[1];
    if (/^https?:\/\//i.test(src)) continue; // CDN scripts tracked separately
    localSrcs.push(src);
  }
  if (!localSrcs.length) {
    fail('found no local <script src> tags in index.html, check the regex or the file moved');
    return;
  }

  const coreAssetsMatch = swJs.match(/CORE_ASSETS\s*=\s*\[([\s\S]*?)\];/);
  if (!coreAssetsMatch) {
    fail('could not find CORE_ASSETS array in sw.js');
    return;
  }
  const coreAssetsBody = coreAssetsMatch[1];

  localSrcs.forEach((src) => {
    // index.html references are relative to the app root ("Worker/app.js?v=1.3"),
    // sw.js CORE_ASSETS uses the same path prefixed with "./" ("./Worker/app.js?v=1.3").
    const expected = './' + src;
    const found = coreAssetsBody.includes("'" + expected + "'") || coreAssetsBody.includes('"' + expected + '"');
    if (!found) {
      fail(
        'index.html references "' + src + '" but sw.js CORE_ASSETS has no matching entry "' + expected + '". ' +
        'Every ?v= query string must match exactly between index.html and sw.js CORE_ASSETS.'
      );
    } else {
      pass('index.html script "' + src + '" matches sw.js CORE_ASSETS entry "' + expected + '"');
    }
  });
})();

/* ─── 2. sw.js CACHE_NAME equals 'kjr-portfolio-' + APP_VERSION. ────────
   Convention adopted 03/07/2026 (see Docs plan A4): CACHE_NAME must move in
   lockstep with APP_VERSION, no more separate manual "vNN" bumping. ───── */
(function checkCacheName() {
  const appVersionMatch = appJs.match(/const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!appVersionMatch) {
    fail('could not find APP_VERSION in Worker/app.js');
    return;
  }
  const appVersion = appVersionMatch[1];

  const cacheNameMatch = swJs.match(/const\s+CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
  if (!cacheNameMatch) {
    fail('could not find CACHE_NAME in sw.js');
    return;
  }
  const cacheName = cacheNameMatch[1];

  const expected = 'kjr-portfolio-' + appVersion;
  if (cacheName !== expected) {
    fail(
      'sw.js CACHE_NAME is "' + cacheName + '" but Worker/app.js APP_VERSION is "' + appVersion + '". ' +
      'Expected CACHE_NAME to be "' + expected + '". Bump CACHE_NAME every deploy so returning visitors ' +
      'discard the old offline shell.'
    );
  } else {
    pass('sw.js CACHE_NAME "' + cacheName + '" matches APP_VERSION "' + appVersion + '"');
  }
})();

/* ─── 3. APP_VERSION appears inside APP_DISPLAY_VERSION. ───────────────── */
(function checkDisplayVersion() {
  const appVersionMatch = appJs.match(/const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  const displayVersionMatch = appJs.match(/const\s+APP_DISPLAY_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!appVersionMatch || !displayVersionMatch) {
    fail('could not find APP_VERSION and/or APP_DISPLAY_VERSION in Worker/app.js');
    return;
  }
  const appVersion = appVersionMatch[1];
  const displayVersion = displayVersionMatch[1];
  if (!displayVersion.includes(appVersion)) {
    fail(
      'APP_DISPLAY_VERSION "' + displayVersion + '" does not contain APP_VERSION "' + appVersion + '". ' +
      'They must be bumped together every deploy.'
    );
  } else {
    pass('APP_DISPLAY_VERSION "' + displayVersion + '" contains APP_VERSION "' + appVersion + '"');
  }
})();

console.log('\nRelease check: ' + (failures === 0 ? 'all checks passed.' : failures + ' check(s) failed.'));
if (failures > 0) process.exit(1);
