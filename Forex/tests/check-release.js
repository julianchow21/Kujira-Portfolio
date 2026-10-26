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

   sw.js stores two kinds of entry. SHELL is precached at install. SHARED and
   FIRST_USE are stored only when a page first loads them through the worker.
   The 218 KB Supabase SDK belongs to FIRST_USE alone (check 7), so installing
   for a local-owner journal never downloads it and an Auth-on visit still
   gets it cached for offline.

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
// The quoted entries of a top-level array in sw.js (SHELL, SHARED, FIRST_USE), or null when the array is not there.
function swList(name) {
  const match = swJs.match(new RegExp('\\b' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\];'));
  return match ? [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]) : null;
}

/* ─── 1. Every local runtime script and stylesheet referenced by the six
   public Forex pages must appear in sw.js SHELL, or in the store-on-first-use
   list FIRST_USE, with the identical path AND identical query string. The
   reverse check applies to every versioned SHELL entry and every FIRST_USE
   entry, so a stale or arbitrary versioned cache entry fails. ────────────── */
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

  // Store-on-first-use entries are not precached, a file that only some visits load (the Supabase SDK, behind the Auth gate) is listed there instead of SHELL.
  const firstUseEntries = swList('FIRST_USE');
  if (!firstUseEntries) {
    fail('could not find FIRST_USE array in sw.js');
    return;
  }
  const firstUseByPath = new Map();
  firstUseEntries.forEach((entry) => {
    const normal = normalise(entry);
    const sourcePath = normal.split('?')[0];
    if (!firstUseByPath.has(sourcePath)) firstUseByPath.set(sourcePath, []);
    firstUseByPath.get(sourcePath).push(normal);
  });

  // Forward: every local runtime reference must appear in SHELL, or in
  // FIRST_USE, with the identical path and query string. A path with a
  // different query is a mismatch, even if another entry has the same path.
  runtimeRefs.forEach((asset) => {
    const normal = asset.source.startsWith('./') ? asset.source.slice(2) : asset.source;
    const sourcePath = normal.split('?')[0];
    const matches = shellByPath.get(sourcePath) || [];
    const firstUseMatches = firstUseByPath.get(sourcePath) || [];
    if (!matches.includes(normal)) {
      if (firstUseMatches.includes(normal)) {
        pass(asset.page + ' ' + asset.kind + ' "' + asset.source + '" matches sw.js FIRST_USE entry "./' + normal + '" (stored on first use, not precached)');
      } else if (firstUseMatches.length) {
        fail('query mismatch for ' + asset.page + ' ' + asset.kind + ' "' + sourcePath + '": page has "' + (normal.split('?')[1] || '(none)') + '" but sw.js FIRST_USE has "' + firstUseMatches.join(', ') + '". Every query string must match exactly.');
      } else if (!matches.length) {
        fail(asset.page + ' ' + asset.kind + ' "' + asset.source + '" has no matching sw.js SHELL path. Add "./' + normal + '" to SHELL (or to FIRST_USE if only some visits load it).');
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
  // The same for every FIRST_USE entry: it must still be a file a page references, at the identical query string.
  firstUseEntries.forEach((entry) => {
    if (!runtimeSet.has(normalise(entry))) {
      fail(
        'sw.js FIRST_USE has "' + entry + '" but the Forex runtime pages have no matching script or stylesheet reference with the identical query string. ' +
        'Remove the stale FIRST_USE entry or add/update the matching page asset.'
      );
    } else {
      pass('sw.js FIRST_USE entry "' + entry + '" matches a Forex runtime script or stylesheet reference');
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

/* ─── 4. Links between the Forex pages must be exact sw.js SHELL URLs.
   A link such as ./index.html?v=0.14 goes stale at every release, and the
   service worker now stores only exact SHELL URLs, so a query string would
   also make the visit an uncached one. Links to the pages carry no query
   string, so they cannot drift. Covers the page markup and the two public
   scripts that write links at runtime. ──────────────────────────────────── */
(function checkInternalLinks() {
  const shellMatch = swJs.match(/SHELL\s*=\s*\[([\s\S]*?)\];/);
  if (!shellMatch) {
    fail('could not find SHELL array in sw.js');
    return;
  }
  const normalise = (p) => p.replace(/^\.\//, '');
  const shell = new Set([...shellMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => normalise(m[1])));
  const sources = RUNTIME_PAGES.map((page) => ({
    label: page,
    links: [...pageHtml[page].matchAll(/\bhref\s*=\s*["'](\.\/[^"']*)["']/gi)].map((m) => m[1])
  }));
  ['public-config.js', 'lib/public.js'].forEach((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    sources.push({ label: file, links: [...text.matchAll(/['"](\.\/[^'"\s]*)['"]/g)].map((m) => m[1]) });
  });
  sources.forEach(({ label, links }) => {
    let bad = 0;
    links.forEach((link) => {
      const target = link.split('#')[0];
      if (target.includes('?')) {
        fail(label + ' links to "' + link + '" with a query string. Link to the plain page so the URL matches its sw.js SHELL entry and cannot go stale.');
        bad++;
      } else if (!shell.has(normalise(target))) {
        fail(label + ' links to "' + link + '" which is not an sw.js SHELL entry.');
        bad++;
      }
    });
    if (!bad) pass(label + ': ' + links.length + ' internal link(s), all plain SHELL URLs');
  });
})();

/* ─── 5. Shared files the worker stores on first use (sw.js SHARED) must exist
   and must be the files the app page actually shows. ────────────────────── */
(function checkSharedAssets() {
  const sharedMatch = swJs.match(/SHARED\s*=\s*\[([\s\S]*?)\];/);
  if (!sharedMatch) {
    fail('could not find SHARED array in sw.js');
    return;
  }
  const entries = [...sharedMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (!entries.length) {
    fail('sw.js SHARED is empty, remove the array or list the shared files');
    return;
  }
  entries.forEach((entry) => {
    if (!fs.existsSync(path.join(ROOT, entry))) fail('sw.js SHARED entry "' + entry + '" does not exist relative to Forex/.');
    else if (!indexHtml.includes('src="' + entry + '"')) fail('sw.js SHARED entry "' + entry + '" is not used by index.html, remove it or fix the path.');
    else pass('sw.js SHARED entry "' + entry + '" exists and is used by index.html');
  });
})();

/* ─── 6. The Supabase SDK loads only behind the Auth gate. index.html keeps
   one inert tag (type="text/plain", so the browser never fetches it) that
   holds the path, version and SRI hash for the checks above. The inline
   script after it re-emits the tag, in order and before auth-client.js, only
   when the resolved config says Auth is enabled. No other page loads it. ── */
(function checkSdkGate() {
  const sdkTags = indexHtml.match(/<script\b[^>]*\bsrc=["']lib\/supabase-[^"']*["'][^>]*>/gi) || [];
  if (sdkTags.length !== 1) {
    fail('index.html must reference the Supabase SDK in exactly one script tag, found ' + sdkTags.length);
    return;
  }
  if (!/\btype\s*=\s*["']text\/plain["']/i.test(sdkTags[0])) {
    fail('the Supabase SDK tag in index.html must be inert (type="text/plain"), a live tag loads 218 KB on every boot even with Auth off.');
    return;
  }
  if (!/\bintegrity\s*=\s*["']sha384-/i.test(sdkTags[0]) || !/\bcrossorigin\s*=\s*["']anonymous["']/i.test(sdkTags[0])) {
    fail('the Supabase SDK tag in index.html must keep its sha384 integrity hash and crossorigin="anonymous".');
    return;
  }
  const gate = /id="supabase-sdk"[^>]*><\/script>\s*<script>([\s\S]*?)<\/script>\s*<script src="lib\/auth-client\.js/.exec(indexHtml);
  if (!gate) {
    fail('index.html must hold the Auth-gated SDK loader between the inert SDK tag and lib/auth-client.js.');
    return;
  }
  const loader = gate[1];
  if (!/KjrForexConfig/.test(loader) || !/\.resolve\(/.test(loader) || !/\.authEnabled/.test(loader) || !/document\.write\(/.test(loader)) {
    fail('the SDK loader must resolve KjrForexConfig, test authEnabled and document.write the tag so the SDK stays parser-blocking.');
    return;
  }
  const others = RUNTIME_PAGES.filter((page) => page !== 'index.html' && /lib\/supabase-/.test(pageHtml[page]));
  if (others.length) {
    fail('only index.html may load the Supabase SDK, found it in ' + others.join(', '));
    return;
  }
  pass('the Supabase SDK is an inert tag plus an Auth-gated loader before lib/auth-client.js, and no other page loads it');
})();

/* ─── 7. The SDK is stored on first use and never precached. Installing the
   app must not download its 218 KB, only a visit that actually loads it
   (Auth on) does. So sw.js lists it in FIRST_USE, at the exact path and ?v=
   string the inert tag in index.html carries, keeps it out of SHELL, and the
   worker's storage rule reads FIRST_USE. The file must exist. ────────────── */
(function checkSdkFirstUse() {
  const tag = (indexHtml.match(/<script\b[^>]*\bsrc=["']lib\/supabase-[^"']*["'][^>]*>/i) || [])[0];
  if (!tag) {
    fail('index.html has no Supabase SDK script tag to compare with sw.js.');
    return;
  }
  const src = /\bsrc=["']([^"']+)["']/i.exec(tag)[1];
  const shell = swList('SHELL'), firstUse = swList('FIRST_USE');
  if (!shell || !firstUse) {
    fail('could not find the SHELL and FIRST_USE arrays in sw.js.');
    return;
  }
  const normalise = (p) => p.replace(/^\.\//, '');
  const precached = shell.filter((entry) => /(^|\/)supabase-/.test(normalise(entry)));
  if (precached.length) {
    fail('sw.js SHELL precaches the Supabase SDK ("' + precached.join('", "') + '"), so every install downloads 218 KB even with Auth off. List it in FIRST_USE instead.');
    return;
  }
  const listed = firstUse.filter((entry) => normalise(entry) === src);
  if (listed.length !== 1) {
    fail('sw.js FIRST_USE must list the Supabase SDK exactly once, as "./' + src + '" (the path and ?v= string index.html references), found ' + (firstUse.length ? '"' + firstUse.join('", "') + '"' : 'an empty list') + '.');
    return;
  }
  if (!fs.existsSync(path.join(ROOT, src.split('?')[0]))) {
    fail('the Supabase SDK file "' + src.split('?')[0] + '" does not exist relative to Forex/.');
    return;
  }
  if (!/storable\s*=\s*new Set\([^;]*\bFIRST_USE\b/.test(swJs)) {
    fail('sw.js isStorable() must build its set from FIRST_USE, or the SDK is listed but never stored.');
    return;
  }
  if (/addAll\([^)]*\bFIRST_USE\b/.test(swJs)) {
    fail('sw.js must not precache FIRST_USE, the install takes SHELL alone.');
    return;
  }
  pass('the Supabase SDK "./' + src + '" is stored on first use (sw.js FIRST_USE) and is not in the install SHELL');
})();

console.log('\nRelease check: ' + (failures === 0 ? 'all checks passed.' : failures + ' check(s) failed.'));
if (failures > 0) process.exit(1);
