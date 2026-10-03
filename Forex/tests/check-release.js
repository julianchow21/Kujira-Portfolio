/* Release consistency check (mirrors Portfolio/tests/check-release.js house style).
   Node, zero dependencies. Catches the "shipped stale code to returning
   visitors" class of bug: the six Forex pages' local runtime assets,
   sw.js's pre-cache SHELL list, and the APP.version badge must all agree,
   every deploy, or a returning visitor's service worker keeps serving an
   old build forever.

   Mapping rule (documented here, enforced by check 2 below): sw.js CACHE
   must equal 'kjr-forex-v' + the numeric part of APP.version in index.html
   (e.g. APP.version 'v0.7 (18 Jul)' -> CACHE 'kjr-forex-v0.7'). Bumping
   APP.version therefore forces a matching CACHE bump, exactly like
   Portfolio's CACHE_NAME = 'kjr-portfolio-' + APP_VERSION rule.

   Path-resolved via __dirname so it runs from any cwd (repo root, Forex/,
   CI). Exits non-zero with a clear message naming the mismatched values. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SW_JS_PATH = path.join(ROOT, 'sw.js');
const RUNTIME_PAGES = ['index.html', 'welcome.html', 'pricing.html', 'terms.html', 'privacy.html', 'refunds.html'];

let failures = 0;
function fail(msg) {
  console.error('FAIL: ' + msg);
  failures++;
}
function pass(msg) {
  console.log('PASS: ' + msg);
}

const pageHtml = {};
for (const page of RUNTIME_PAGES) {
  const file = path.join(ROOT, page);
  try {
    pageHtml[page] = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error('HARNESS ERROR: could not read ' + file + ': ' + e.message);
    process.exit(1);
  }
}
const indexHtml = pageHtml['index.html'];
let swJs;
try {
  swJs = fs.readFileSync(SW_JS_PATH, 'utf8');
} catch (e) {
  console.error('HARNESS ERROR: could not read ' + SW_JS_PATH + ': ' + e.message);
  process.exit(1);
}

/* ─── 1. Every local runtime script and stylesheet referenced by the six
   public Forex pages must appear in sw.js SHELL with the identical path AND
   identical query string. The reverse check applies to every versioned SHELL
   runtime asset, so a stale or arbitrary versioned cache entry fails. ────── */
(function checkRuntimeAssetsVsShell() {
  const runtimeAssets = [];
  const tagRe = /<(script|link)\b[^>]*>/gi;
  const attr = (tag, name) => {
    const match = new RegExp("\\b" + name + "\\s*=\\s*[\"']([^\"']+)[\"']", 'i').exec(tag);
    return match ? match[1] : '';
  };
  const external = (value) => /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value);

  for (const page of RUNTIME_PAGES) {
    let match;
    tagRe.lastIndex = 0;
    while ((match = tagRe.exec(pageHtml[page]))) {
      const tag = match[0];
      const kind = match[1].toLowerCase();
      if (kind === 'link' && !/\brel\s*=\s*["']stylesheet["']/i.test(tag)) continue;
      const source = attr(tag, kind === 'script' ? 'src' : 'href');
      if (!source || external(source)) continue;
      runtimeAssets.push({ page, kind, source });
    }
  }

  const runtimeByRef = new Map();
  runtimeAssets.forEach((asset) => {
    const key = asset.source.startsWith('./') ? asset.source.slice(2) : asset.source;
    const existing = runtimeByRef.get(key);
    if (existing) existing.pages.push(asset.page);
    else runtimeByRef.set(key, { ...asset, pages: [asset.page] });
  });
  const runtimeRefs = [...runtimeByRef.values()];
  if (!runtimeRefs.length) {
    fail('found no local runtime script or stylesheet references across the Forex pages');
    return;
  }

  const shellMatch = swJs.match(/SHELL\s*=\s*\[([\s\S]*?)\];/);
  if (!shellMatch) {
    fail('could not find SHELL array in sw.js');
    return;
  }
  const shellBody = shellMatch[1];
  const shellEntries = [];
  const entryRe = /['"]([^'"]+)['"]/g;
  let em;
  while ((em = entryRe.exec(shellBody))) shellEntries.push(em[1]);
  if (!shellEntries.length) {
    fail('found no entries in sw.js SHELL array, check the regex or the array moved');
    return;
  }

  const normalise = (p) => (p.startsWith('./') ? p.slice(2) : p);
  const shellByPath = new Map();
  shellEntries.forEach((entry) => {
    const normal = normalise(entry);
    const sourcePath = normal.split('?')[0];
    if (!shellByPath.has(sourcePath)) shellByPath.set(sourcePath, []);
    shellByPath.get(sourcePath).push(normal);
  });

  // Forward: every local runtime reference must appear in SHELL with the
  // identical path and query string. A path with a different query is a
  // mismatch, even if another SHELL entry has the same path.
  runtimeRefs.forEach((asset) => {
    const normal = asset.source.startsWith('./') ? asset.source.slice(2) : asset.source;
    const sourcePath = normal.split('?')[0];
    const matches = shellByPath.get(sourcePath) || [];
    if (!matches.includes(normal)) {
      if (!matches.length) {
        fail(asset.page + ' ' + asset.kind + ' "' + asset.source + '" has no matching sw.js SHELL path. Add "./' + normal + '" to SHELL.');
      } else {
        fail('query mismatch for ' + asset.page + ' ' + asset.kind + ' "' + sourcePath + '": page has "' + (normal.split('?')[1] || '(none)') + '" but sw.js SHELL has "' + matches.join(', ') + '". Every query string must match exactly.');
      }
      return;
    }
    const shellEntry = shellEntries.find((entry) => normalise(entry) === normal);
    pass(asset.page + ' ' + asset.kind + ' "' + asset.source + '" matches sw.js SHELL entry "' + shellEntry + '"');
  });

  // Reverse: every versioned SHELL entry must match one of the runtime assets
  // in the six pages. Unversioned shell documents, icons and manifests remain
  // explicit offline-shell entries and are not treated as runtime references.
  const versionedShellEntries = shellEntries.filter((e) => e.includes('?v='));
  if (!versionedShellEntries.length) {
    fail('found no versioned (?v=) entries in sw.js SHELL, check the regex or the entries moved');
  }
  const runtimeSet = new Set(runtimeRefs.map((asset) => normalise(asset.source)));
  versionedShellEntries.forEach((entry) => {
    const normEntry = normalise(entry);
    if (!runtimeSet.has(normEntry)) {
      fail(
        'sw.js SHELL has "' + entry + '" but the Forex runtime pages have no matching script or stylesheet reference with the identical query string. ' +
        'Remove the stale SHELL entry or add/update the matching page asset.'
      );
    } else {
      pass('sw.js SHELL entry "' + entry + '" matches a Forex runtime script or stylesheet reference');
    }
  });
})();

/* ─── 2. sw.js CACHE equals 'kjr-forex-v' + the numeric part of APP.version.
   See file header for the full mapping rule. ────────────────────────────── */
(function checkCacheName() {
  const appMatch = indexHtml.match(/const APP = \{[^}]*\};?/);
  if (!appMatch) {
    fail('could not find "const APP = {...}" line in index.html');
    return;
  }
  const appLine = appMatch[0];
  const versionMatch = appLine.match(/version:\s*'([^']+)'/);
  if (!versionMatch) {
    fail('could not find version:\'...\' inside the APP object in index.html');
    return;
  }
  const badge = versionMatch[1];

  const badgeNumMatch = badge.match(/^v(\d+(?:\.\d+)*)\s/);
  if (!badgeNumMatch) {
    fail('APP.version "' + badge + '" does not start with "vN " (e.g. "v0.7 "), cannot derive the expected CACHE name');
    return;
  }
  const badgeNumber = badgeNumMatch[1];

  const cacheMatch = swJs.match(/const CACHE = ([^;]+);/);
  if (!cacheMatch) {
    fail('could not find "const CACHE = ...;" in sw.js');
    return;
  }
  const cacheLiteralMatch = cacheMatch[1].match(/^'([^']*)'$/) || cacheMatch[1].match(/^"([^"]*)"$/);
  if (!cacheLiteralMatch) {
    fail('sw.js CACHE is not a plain string literal ("' + cacheMatch[1].trim() + '"), cannot check it against APP.version');
    return;
  }
  const cache = cacheLiteralMatch[1];

  const expected = 'kjr-forex-v' + badgeNumber;
  if (cache !== expected) {
    fail(
      'sw.js CACHE is "' + cache + '" but index.html APP.version is "' + badge + '" (number "' + badgeNumber + '"). ' +
      'Expected CACHE to be "' + expected + '". Bump CACHE together with APP.version every deploy so returning ' +
      'visitors discard the old offline shell.'
    );
  } else {
    pass('sw.js CACHE "' + cache + '" matches APP.version "' + badge + '"');
  }
})();

/* ─── 3. APP.version matches the house badge format, e.g. "v0.7 (18 Jul)". ── */
(function checkBadgeFormat() {
  const appMatch = indexHtml.match(/const APP = \{[^}]*\};?/);
  if (!appMatch) {
    fail('could not find "const APP = {...}" line in index.html');
    return;
  }
  const versionMatch = appMatch[0].match(/version:\s*'([^']+)'/);
  if (!versionMatch) {
    fail('could not find version:\'...\' inside the APP object in index.html');
    return;
  }
  const badge = versionMatch[1];

  const badgeRe = /^v\d+(?:\.\d+)* \(\d{1,2} [A-Z][a-z]{2}\)$/;
  if (!badgeRe.test(badge)) {
    fail(
      'APP.version "' + badge + '" does not match the house badge format "vN(.N...) (D Mon)", e.g. "v0.7 (18 Jul)".'
    );
  } else {
    pass('APP.version "' + badge + '" matches the house badge format');
  }
})();

console.log('\nRelease check: ' + (failures === 0 ? 'all checks passed.' : failures + ' check(s) failed.'));
if (failures > 0) process.exit(1);
