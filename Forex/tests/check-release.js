/* Release consistency check (mirrors Portfolio/tests/check-release.js house style).
   Node, zero dependencies. Catches the "shipped stale code to returning
   visitors" class of bug: index.html's local <script src> tags, sw.js's
   pre-cache SHELL list, and the APP.version badge must all agree, every
   deploy, or a returning visitor's service worker keeps serving an old
   build forever.

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
const INDEX_HTML_PATH = path.join(ROOT, 'index.html');
const SW_JS_PATH = path.join(ROOT, 'sw.js');

let failures = 0;
function fail(msg) {
  console.error('FAIL: ' + msg);
  failures++;
}
function pass(msg) {
  console.log('PASS: ' + msg);
}

let indexHtml, swJs;
try {
  indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
} catch (e) {
  console.error('HARNESS ERROR: could not read ' + INDEX_HTML_PATH + ': ' + e.message);
  process.exit(1);
}
try {
  swJs = fs.readFileSync(SW_JS_PATH, 'utf8');
} catch (e) {
  console.error('HARNESS ERROR: could not read ' + SW_JS_PATH + ': ' + e.message);
  process.exit(1);
}

/* ─── 1. Every versioned local <script src> tag in index.html matches an
   entry in sw.js SHELL with the identical path AND identical ?v= string
   (forward), and every ?v= SHELL entry matches an index.html script tag
   (reverse). Unversioned SHELL entries (the app shell itself, icon,
   manifest) are exempt from the reverse check. ────────────────────────── */
(function checkScriptTagsVsShell() {
  const scriptSrcRe = /<script\s+[^>]*src=["']([^"']+)["'][^>]*>/g;
  const localSrcs = [];
  let m;
  while ((m = scriptSrcRe.exec(indexHtml))) {
    const src = m[1];
    if (/^https?:\/\//i.test(src)) continue; // CDN scripts, none expected here, tracked separately if added
    localSrcs.push(src);
  }
  if (!localSrcs.length) {
    fail('found no local <script src> tags in index.html, check the regex or the file moved');
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

  // Forward: every versioned script tag must appear in SHELL with the identical
  // path and identical ?v= string. A version mismatch prints both values, this
  // is the near-miss class this file exists to catch.
  const versionedSrcs = localSrcs.filter((src) => src.includes('?v='));
  if (!versionedSrcs.length) {
    fail('found no versioned (?v=) local <script src> tags in index.html, check the regex or the tags moved');
  }
  versionedSrcs.forEach((src) => {
    const normSrc = normalise(src);
    const srcPath = normSrc.split('?')[0];
    const srcVersion = normSrc.split('?')[1];
    const shellMatchEntry = shellEntries.find((e) => normalise(e).split('?')[0] === srcPath);
    if (!shellMatchEntry) {
      fail(
        'index.html references "' + src + '" but sw.js SHELL has no matching path. ' +
        'Add "./' + normSrc + '" to SHELL.'
      );
      return;
    }
    const shellVersion = normalise(shellMatchEntry).split('?')[1];
    if (shellVersion !== srcVersion) {
      fail(
        'version mismatch for "' + srcPath + '": index.html has "?' + (srcVersion || '(none)') +
        '" but sw.js SHELL has "?' + (shellVersion || '(none)') + '". Every ?v= query string must match exactly.'
      );
    } else {
      pass('index.html script "' + src + '" matches sw.js SHELL entry "' + shellMatchEntry + '"');
    }
  });

  // Reverse: every SHELL entry containing ?v= must match a script tag in
  // index.html with the identical ?v= string. Catches a stale leftover SHELL
  // entry (e.g. a deleted or renamed lib script) the forward check can't see.
  const exemptShellEntries = new Set(['./', './index.html', './icon.svg', './manifest.webmanifest']);
  const versionedShellEntries = shellEntries.filter((e) => e.includes('?v=') && !exemptShellEntries.has(e));
  if (!versionedShellEntries.length) {
    fail('found no versioned (?v=) entries in sw.js SHELL, check the regex or the entries moved');
  }
  const indexScriptSet = new Set(localSrcs.map((src) => normalise(src)));
  versionedShellEntries.forEach((entry) => {
    const normEntry = normalise(entry);
    if (!indexScriptSet.has(normEntry)) {
      fail(
        'sw.js SHELL has "' + entry + '" but index.html has no matching <script src> tag with the identical ?v=. ' +
        'Remove the stale SHELL entry or add/update the matching script tag.'
      );
    } else {
      pass('sw.js SHELL entry "' + entry + '" matches an index.html script tag');
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
