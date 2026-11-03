#!/usr/bin/env node
/*
 * Kujira Portfolio, cross-browser smoke pass (opt-in).
 *
 * Drives the Portfolio app in Playwright Chromium (baseline), WebKit and
 * Firefox, then reports engine-specific differences. It is NOT part of
 * `npm test` and Playwright is NOT a dependency of any package.json.
 *
 * Run (from the repo root):
 *
 *   npm i -g playwright@1.64.0
 *   npx -y playwright@1.64.0 install --with-deps chromium webkit firefox
 *   npx serve -l 3807 .                         (leave running in a second terminal)
 *   node Portfolio/tests/cross-browser.mjs
 *
 * One engine on its own (no Chromium comparison is made then):
 *   node Portfolio/tests/cross-browser.mjs --engines=webkit
 * Results land in <out>/report.json plus one screenshot per page, theme and
 * width. Keep <out> outside the repo, screenshots hold the seed figures.
 *
 * Options:
 *   --engines=chromium,webkit,firefox   engines to run, in order (default all three)
 *   --base=http://localhost:3807        dev server origin for the main checks, must be localhost or 127.0.0.1
 *   --out=<dir>                         report and screenshots (default <tmp>/kjr-browser-qa)
 *   --chromium-path=<file>              Chromium binary override (env KJR_CHROMIUM_PATH)
 *   --headed                            show the browser windows
 *   --self-test                         no browser: check the expected-error filter against known engine wording,
 *                                       the throwaway server's path guard and the Firefox home rule
 * Env KJR_PLAYWRIGHT=<path to the playwright package> if it is not resolvable.
 *
 * Offline check (service worker), the server really goes away:
 * - The service worker checks do not use --base. The script starts its own static server (Node http, 127.0.0.1
 *   only, a free port, the repo root, read-only). The worker installs from that origin, then the script closes
 *   the server, destroys its open connections and reloads, so the worker is the only thing left that can answer.
 *   The check fails if the server still answers after the close.
 * - context.setOffline(true) is not used. In Firefox it makes the reload throw NS_ERROR_OFFLINE before the
 *   worker is asked (F6 in Docs/Browser QA.md). The real shutdown works the same way in all three engines, so
 *   there is one code path.
 * - The server answers GET and HEAD only. It refuses path traversal, dot paths (.git, .env), symlinks that
 *   leave the root and files that are not web types (the tree can hold a git-ignored .xlsx). It is closed on
 *   every way out of the script.
 *
 * Firefox on macOS:
 * - Firefox only starts there when CFFIXED_USER_HOME names an empty writable folder. With the real home it
 *   prints "Could not find profile folder." and exits. When the engine is Firefox, the platform is darwin and
 *   CFFIXED_USER_HOME is unset, the script makes an empty temp folder, passes it in the launch env (merged with
 *   process.env) and removes it at the end. A plain rerun needs no setup. A CFFIXED_USER_HOME you set yourself
 *   is used as it is and never removed.
 *
 * Safety:
 * - Every request to a host other than localhost or 127.0.0.1 is aborted by a
 *   context route and logged. Each browser also runs behind a local black-hole
 *   proxy that refuses and logs anything the route cannot see (for example a
 *   service worker fetch in an engine where routes do not reach the worker).
 *   Proxy entries also catch the browser's own background calls (Chromium
 *   pings Google update and account hosts). Those come from the browser, not
 *   the app, and they are refused all the same.
 * - Each engine gets a fresh context seeded only from the QA seed fixture
 *   through localStorage. No sync URL, no credentials, no NAS mode, ever.
 *   The run aborts if either appears in storage, on the --base origin or on
 *   the throwaway server's origin.
 * - Exit code 0 when every engine that launched passed every check, 1 when a
 *   check failed or an engine could not launch, 2 on a safety violation.
 */

import { createRequire } from 'node:module';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..'); // the folder the throwaway server serves
const SEED_FILE = path.join(HERE, 'fixtures', 'QA Seed v1 (05 Sep).json');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const ALL_ENGINES = ['chromium', 'webkit', 'firefox'];
const TABS = ['dashboard', 'projections', 'explore', 'stocks', 'crypto', 'cash', 'cpf',
  'realestate', 'insurance', 'cashflow', 'board', 'settings'];
const VIEWPORTS = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };
const THEMES = ['dark', 'light'];
// localStorage keys from Worker/app.js
const LK = {
  db: 'kjr-pf-db-v1', prices: 'kjr-pf-price-cache-v1', theme: 'kjr-pf-theme-v1',
  wizard: 'kjr-pf-wizard-dismissed-v1', syncUrl: 'kjr-pf-sync-url-v1',
  backend: 'kjr-pf-backend-mode-v1', seeded: 'kjr-qa-cross-browser-seeded'
};

/* ── arguments ─────────────────────────────────────────────────────────── */
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const ENGINES = String(args.engines || ALL_ENGINES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const BASE = String(args.base || 'http://localhost:3807').replace(/\/$/, '');
const APP_URL = BASE + '/Portfolio/';
const OUT = path.resolve(String(args.out || path.join(os.tmpdir(), 'kjr-browser-qa')));
const CHROMIUM_PATH = args['chromium-path'] || process.env.KJR_CHROMIUM_PATH || undefined;
if (!LOCAL_HOSTS.has(new URL(BASE).hostname)) {
  console.error('--base must point at localhost or 127.0.0.1, got ' + BASE);
  process.exit(2);
}
for (const e of ENGINES) if (!ALL_ENGINES.includes(e)) { console.error('Unknown engine ' + e); process.exit(2); }

/* ── Playwright, resolved without any package.json entry ──────────────── */
function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = [process.env.KJR_PLAYWRIGHT, 'playwright'];
  try { tries.push(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); } catch (_) {}
  for (const t of tries.filter(Boolean)) {
    try { return req(t); } catch (_) {}
  }
  console.error('Playwright not found. Run: npm i -g playwright@1.64.0 (or set KJR_PLAYWRIGHT).');
  process.exit(1);
}
const pw = args['self-test'] ? null : loadPlaywright();

/* ── seed ──────────────────────────────────────────────────────────────── */
const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
const { _priceCache: seedPrices, ...seedDb } = seed;

/* ── exit paths ────────────────────────────────────────────────────────── */
/* The throwaway server and the Firefox temp home put themselves away through this set. Each function is
   synchronous and runs once, on every way out of the script: the end of main, process.exit (the safety abort too),
   an uncaught error, Ctrl-C and kill. Only SIGKILL cannot be caught. */
const cleanups = new Set();
function runCleanups() {
  for (const fn of [...cleanups]) { cleanups.delete(fn); try { fn(); } catch (_) {} }
}
process.on('exit', runCleanups);
for (const [sig, code] of [['SIGINT', 130], ['SIGHUP', 129], ['SIGTERM', 143]]) process.on(sig, () => process.exit(code));

/* ── throwaway static server, for the service worker checks ───────────── */
/* Serves the repo root read-only on 127.0.0.1 and a free port, so the offline check can take the server away for
   real. GET and HEAD only. A target is refused when it is malformed (400), leaves the root, names a dot path such
   as .git or .env, or follows a symlink out of the root (403), or is not there or not a web file type (404). The
   type list matters because the tree can hold personal files that git ignores (an .xlsx sits in Portfolio/Docs). */
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2'
};
function isInside(root, p) { return p === root || p.startsWith(root + path.sep); }
/* `root` must already be a real path. The decoded path is split on "/" (so an encoded slash is a separator, not part
   of a name), and a segment that starts with a dot is refused outright. The resolved path and its real path are
   then checked against the root with a separator on the end, so a sibling folder that shares the root's name as a
   prefix never matches. */
function resolveStaticTarget(root, target) {
  const no = (status, why) => ({ status, why });
  if (typeof target !== 'string' || target[0] !== '/') return no(400, 'not an absolute path');
  let decoded;
  try { decoded = decodeURIComponent(target.split(/[?#]/, 1)[0]); } catch (_) { return no(400, 'bad percent-encoding'); }
  if (/[\0\\]/.test(decoded)) return no(400, 'NUL or backslash in the path');
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some(p => p[0] === '.')) return no(403, 'dot path');
  try {
    const wanted = path.resolve(root, ...parts);
    if (!isInside(root, wanted)) return no(403, 'outside the root');
    let real = fs.realpathSync(wanted);
    if (!isInside(root, real)) return no(403, 'symlink leaves the root');
    if (fs.statSync(real).isDirectory()) {
      if (parts.length && !decoded.endsWith('/')) return no(404, 'a folder needs a trailing slash');
      real = fs.realpathSync(path.join(real, 'index.html'));
      if (!isInside(root, real)) return no(403, 'symlink leaves the root');
    }
    const st = fs.statSync(real);
    const type = STATIC_TYPES[path.extname(real).toLowerCase()];
    if (!st.isFile() || !type) return no(404, 'not a served file');
    return { status: 200, file: real, size: st.size, type };
  } catch (_) { return no(404, 'not found'); }
}
/* Resolves to { port, origin, close }. close() is idempotent: it stops listening, destroys every open connection (a
   kept-alive socket must not answer for a server that is meant to be gone) and resolves once the server has closed.
   The server also registers with the exit paths, so it is closed however the script ends. */
function startStaticServer(root) {
  const realRoot = fs.realpathSync(root);
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const head = { 'Cache-Control': 'public, max-age=0', 'X-Content-Type-Options': 'nosniff' };
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...head, Allow: 'GET, HEAD' }); return res.end(); }
    const r = resolveStaticTarget(realRoot, req.url);
    if (r.status !== 200) {
      const body = r.why + '\n';
      res.writeHead(r.status, { ...head, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }
    res.writeHead(200, { ...head, 'Content-Type': r.type, 'Content-Length': r.size });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(r.file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const closeNow = () => {
    try { server.close(); } catch (_) {}
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    for (const s of sockets) s.destroy();
  };
  let closing = null;
  const close = () => {
    cleanups.delete(closeNow);
    if (!closing) closing = new Promise(resolve => {
      const timer = setTimeout(resolve, 3000); // a close that never finishes must not hang the run
      timer.unref();
      server.once('close', () => { clearTimeout(timer); resolve(); });
      closeNow();
    });
    return closing;
  };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      server.on('error', e => console.log(`  throwaway server error: ${e.message}`));
      cleanups.add(closeNow);
      const { port } = server.address();
      resolve({ port, origin: 'http://127.0.0.1:' + port, close });
    });
  });
}
/* One plain GET on a connection of its own, so a closed server shows up as a refused connection and not as a reused
   socket. Resolves to 'HTTP 200' and the like, or 'down (ECONNREFUSED)'. It never rejects. */
function probeUrl(url, timeoutMs = 3000) {
  return new Promise(resolve => {
    const req = http.get(url, { agent: false }, res => { res.resume(); res.on('end', () => resolve('HTTP ' + res.statusCode)); });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve('down (' + (e.code || e.message) + ')'));
  });
}

/* ── Firefox home on macOS ─────────────────────────────────────────────── */
/* Firefox on macOS starts only when CFFIXED_USER_HOME names an empty writable folder (with the real home it prints
   "Could not find profile folder." and exits). When the caller has not set the variable (an empty value counts as
   unset), the Firefox pass gets a fresh empty folder through the launch env, merged with the environment so PATH
   and the rest still reach the browser. A value the caller set is used as it is and never touched.
   remove() needs one extra step on macOS. Firefox makes Library, Downloads and Documents in the pretend home, and
   macOS gives those standard folders a "deny delete" ACL, so a plain rm stops with "Permission denied" (rmSync:
   ENOTEMPTY) and leaves the folders behind. Stripping the ACLs first fixes it. remove() returns true when the folder
   is gone. On false it stays registered, so the exit paths try once more. */
function needsFirefoxHome(engine, platform = process.platform, env = process.env) {
  return engine === 'firefox' && platform === 'darwin' && !env.CFFIXED_USER_HOME;
}
function makeFirefoxHome(engine, platform = process.platform, env = process.env) {
  if (!needsFirefoxHome(engine, platform, env)) return null;
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kjr-firefox-home-')); } catch (e) {
    console.log(`[${engine}] could not make a temp home (${e.message}), launching without one`);
    return null;
  }
  const remove = () => {
    try {
      if (platform === 'darwin') { try { execFileSync('chmod', ['-R', '-N', dir], { stdio: 'ignore' }); } catch (_) {} }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (_) { return false; }
    cleanups.delete(remove);
    return true;
  };
  cleanups.add(remove);
  return { dir, env: { ...env, CFFIXED_USER_HOME: dir }, remove };
}

/* ── network guard: black-hole proxy plus a route abort ────────────────── */
const blocked = []; // { engine, via, url }
function logBlocked(engine, via, url) {
  if (!blocked.some(b => b.engine === engine && b.via === via && b.url === url)) blocked.push({ engine, via, url });
}
let proxyEngine = '';
function startBlackHole() {
  const srv = http.createServer((req, res) => {
    logBlocked(proxyEngine, 'proxy', req.url);
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('blocked by cross-browser.mjs');
  });
  srv.on('connect', (req, socket) => {
    logBlocked(proxyEngine, 'proxy', 'https://' + req.url);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

/* ── results ───────────────────────────────────────────────────────────── */
const results = []; // { engine, area, page, check, ok, detail, shot }
const engineState = {}; // engine -> { launched, error, version, intl, rendered, css }
function record(engine, area, pageName, check, ok, detail, shot) {
  results.push({ engine, area, page: pageName, check, ok: !!ok, detail: detail === undefined ? '' : detail, shot: shot || '' });
  if (!ok) console.log(`  FAIL [${engine}] ${area} ${pageName}: ${check} ${detail ? '-> ' + JSON.stringify(detail) : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function step(engine, area, pageName, check, fn) {
  try { return await fn(); } catch (e) {
    record(engine, area, pageName, check, false, 'threw: ' + String(e && e.message || e).split('\n')[0]);
    return undefined;
  }
}

/* ── per-page console capture ──────────────────────────────────────────── */
function isExternalUrl(u) {
  try { return !!u && /^https?:/.test(u) && !LOCAL_HOSTS.has(new URL(u).hostname); } catch (_) { return false; }
}
/* A blocked external load is expected under the network guard, and every engine words it differently:
   - Chromium: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT" with the external URL as the location
   - WebKit: "Failed to preconnect to https://fonts.gstatic.com/" for a preconnect hint, and "Failed to load resource" or
     "... due to access control checks" for a load
   - WebKit page errors (F5, the service worker's cache-first fetch fails): "TypeError: Load failed" and the external
     URL on its own, both with no stack. Playwright builds a WebKit page error from a console error by splitting the
     text at its first colon and keeping what follows the next two characters (splitErrorMessage in playwright-core,
     checked in 1.64.0), so "https://cdn.jsdelivr.net/x.js." reaches the script as "/cdn.jsdelivr.net/x.js." with the
     scheme and one slash gone. Mac run, WebKit 27.2, 03/11/2026:
     "/cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js."
   A page error counts as expected only when this engine has had a request blocked already, so a real
   "Load failed" from a localhost fetch with no block behind it still fails the check. The scheme-less form must also
   be a dotted host with a path, so an app-origin form ("/localhost:3807/..." or a bare "/sw.js") never matches. */
const EXTERNAL_IN_TEXT = /https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])[^\s'"]+/i;
const BLOCKED_WORDING = /chart\.js|fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|integrity|blocked|preconnect|failed to load|load failed|access control|net::ERR_/i;
const SCHEMELESS_URL = /^\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?\/\S*$/i;
function restoreScheme(m) { return SCHEMELESS_URL.test(m) ? 'https:/' + m : ''; }
function isExpectedConsoleError(text, locUrl) {
  return isExternalUrl(locUrl) || (EXTERNAL_IN_TEXT.test(text) && BLOCKED_WORDING.test(text));
}
function isExpectedPageError(message, hadBlockedLoad) {
  const m = String(message || '').trim();
  if (!hadBlockedLoad) return false;
  return m === 'TypeError: Load failed' || m === 'Load failed' || (isExternalUrl(m) && !/\s/.test(m)) || isExternalUrl(restoreScheme(m));
}
function attachConsole(page, sink, engine) {
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const loc = msg.location() || {};
    const text = msg.text();
    sink.push({ text: text.slice(0, 300), url: loc.url || '', expected: isExpectedConsoleError(text, loc.url) });
  });
  page.on('pageerror', err => {
    const message = String(err && err.message || err);
    const expected = isExpectedPageError(message, blocked.some(b => b.engine === engine));
    sink.push({ text: 'pageerror: ' + message.slice(0, 300), url: '', expected });
  });
}

/* ── helpers that run in the page ──────────────────────────────────────── */
/* Always a real load. Going to the app URL with only a new hash is a same-document navigation in Chromium, so the page
   would keep its old theme and state. A marker on the old document shows when that happened, and a reload follows.
   `url` is the app URL, --base unless the caller (the service worker checks) brings its own origin. */
async function gotoApp(page, hash, url = APP_URL) {
  await page.evaluate(() => { window.__kjrQaOldDocument = true; }).catch(() => {});
  await page.goto(url + (hash ? '#' + hash : ''), { waitUntil: 'load' });
  if (await page.evaluate(() => window.__kjrQaOldDocument === true).catch(() => false)) await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#page-dashboard', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(600); // whenIdle engines and the first renderAll
}
async function setTheme(page, theme) {
  await page.evaluate(([k, t]) => localStorage.setItem(k, t), [LK.theme, theme]);
}
/* The safety read is per origin, so it runs once on the --base origin and once on the service worker origin. */
function storageSafety(page) {
  return page.evaluate(lk => ({ syncUrl: localStorage.getItem(lk.syncUrl), backend: localStorage.getItem(lk.backend) }), LK).catch(() => ({}));
}
const unsafeStorage = s => !!(s && (s.syncUrl || s.backend === 'nas'));
async function activeTab(page) {
  return page.evaluate(() => { const a = document.querySelector('.page.active'); return a ? a.id.replace(/^page-/, '') : null; });
}
async function pageMetrics(page) {
  return page.evaluate(() => {
    const se = document.scrollingElement || document.documentElement;
    const active = document.querySelector('.page.active');
    const wide = [];
    if (active) {
      for (const el of active.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > window.innerWidth + 1 && getComputedStyle(el).position !== 'fixed') {
          // ignore children of an element that scrolls sideways on purpose
          let p = el.parentElement, scrolls = false;
          while (p && p !== active) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') { scrolls = true; break; } p = p.parentElement; }
          if (!scrolls) wide.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '')) + ' right=' + Math.round(r.right));
        }
      }
    }
    return {
      overflowX: se.scrollWidth - se.clientWidth,
      wide: wide.slice(0, 5),
      title: (document.querySelector('.page.active .page-title, .page.active h1, .page.active h2') || {}).textContent || '',
      textLen: active ? active.innerText.trim().length : 0,
      dark: document.documentElement.classList.contains('dark')
    };
  });
}

/* Open a dialog through `open`, then close it with Escape and check where focus went. */
async function dialogRoundTrip(page, { opener, open, dialog, isOpen }) {
  const out = { opened: false, focusInside: false, openerFocusedBeforeOpen: false, closedByEscape: false, focusReturned: false, focusAfterClose: '' };
  await open();
  out.openerFocusedBeforeOpen = await page.evaluate(sel => { const o = document.querySelector(sel); return !!o && o.dataset.qaFocusedAtOpen === '1'; }, opener).catch(() => false);
  for (let i = 0; i < 20 && !out.opened; i++) { out.opened = await page.evaluate(isOpen); if (!out.opened) await sleep(50); }
  if (!out.opened) return out;
  await sleep(150); // openModalFocus moves focus in a requestAnimationFrame
  out.focusInside = await page.evaluate(sel => { const d = document.querySelector(sel); return !!d && d.contains(document.activeElement); }, dialog);
  await page.keyboard.press('Escape');
  for (let i = 0; i < 20 && !out.closedByEscape; i++) { out.closedByEscape = !(await page.evaluate(isOpen)); if (!out.closedByEscape) await sleep(50); }
  await sleep(100);
  const after = await page.evaluate(sel => {
    const a = document.activeElement, o = document.querySelector(sel);
    const desc = a ? (a.id ? '#' + a.id : a.tagName.toLowerCase() + (a.getAttribute('data-click') ? '[data-click=' + a.getAttribute('data-click') + ']' : '')) : 'null';
    return { returned: !!o && a === o, desc };
  }, opener);
  out.focusReturned = after.returned; out.focusAfterClose = after.desc;
  return out;
}
/* Mark the opener when it holds focus at the moment it is activated. Safari and
   Firefox on macOS do not focus a button on mouse click, which matters because
   openModalFocus captures document.activeElement as the opener. */
async function markOpener(page, sel) {
  await page.evaluate(s => {
    const o = document.querySelector(s); if (!o) return;
    delete o.dataset.qaFocusedAtOpen;
    o.addEventListener('click', () => { o.dataset.qaFocusedAtOpen = document.activeElement === o ? '1' : '0'; }, { once: true, capture: true });
  }, sel);
}

/* Safari's mouse click, simulated in any engine: blur whatever holds focus, then dispatch the click without
   moving focus, so the opener is not focused when its handler runs. macOS WebKit and Firefox do exactly this
   on a real click of a button. */
async function safariClick(page, sel) {
  await page.evaluate(s => {
    const o = document.querySelector(s);
    if (!o) throw new Error('missing ' + s);
    if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    o.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, sel);
}

/* ── the pass for one engine ───────────────────────────────────────────── */
async function runEngine(name, proxyPort, ffHome) {
  const state = engineState[name] = { launched: false };
  proxyEngine = name;
  const launchOpts = {
    headless: !args.headed,
    proxy: { server: 'http://127.0.0.1:' + proxyPort, bypass: 'localhost,127.0.0.1' }
  };
  if (name === 'chromium' && CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;
  if (ffHome) { launchOpts.env = ffHome.env; state.tempHome = true; } // Firefox on macOS, see makeFirefoxHome
  let browser;
  try { browser = await pw[name].launch(launchOpts); } catch (e) {
    state.error = String(e && e.message || e).split('\n').slice(0, 3).join(' ');
    console.log(`[${name}] could not launch: ${state.error}`);
    return;
  }
  state.launched = true;
  state.version = browser.version();
  console.log(`[${name}] ${state.version}`);
  const shotDir = path.join(OUT, name);
  fs.mkdirSync(shotDir, { recursive: true });

  const context = await browser.newContext({
    viewport: VIEWPORTS.desktop, locale: 'en-SG', timezoneId: 'Asia/Singapore', serviceWorkers: 'allow'
  });
  await context.route('**/*', route => {
    const url = route.request().url();
    let host = '';
    try { host = new URL(url).hostname; } catch (_) {}
    if (url.startsWith('data:') || url.startsWith('blob:') || LOCAL_HOSTS.has(host)) return route.continue();
    logBlocked(name, 'route', url);
    return route.abort('blockedbyclient');
  });
  // Seed once per context, before any app script runs. The flag stops later reloads from re-seeding.
  await context.addInitScript(([lk, db, prices]) => {
    try {
      if (localStorage.getItem(lk.seeded)) return;
      localStorage.setItem(lk.db, db);
      localStorage.setItem(lk.prices, prices);
      localStorage.setItem(lk.wizard, '1');
      localStorage.setItem(lk.seeded, '1');
    } catch (_) {}
  }, [LK, JSON.stringify(seedDb), JSON.stringify(seedPrices)]);

  const page = await context.newPage();
  const consoleSink = [];
  attachConsole(page, consoleSink, name);
  const takeErrors = () => consoleSink.splice(0, consoleSink.length);

  /* 1. Boot, and what renders with no backend */
  await step(name, 'boot', 'dashboard', 'app boots from the seed', async () => {
    await gotoApp(page);
    const info = await page.evaluate(() => ({
      tab: (document.querySelector('.page.active') || {}).id,
      status: (document.querySelector('#sync-status, .sync-row, [data-click=openSyncDetails]') || {}).textContent || '',
      version: (document.getElementById('logo-version') || {}).textContent || '',
      chartJs: typeof window.Chart
    }));
    state.boot = info;
    record(name, 'boot', 'dashboard', 'dashboard is the active page', info.tab === 'page-dashboard', info);
  });

  /* 2. Every tab, both themes, both widths */
  for (const theme of THEMES) {
    for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(vp);
      await setTheme(page, theme);
      await step(name, 'tabs', vpName + '/' + theme, 'reload', () => gotoApp(page));
      takeErrors();
      for (const tab of TABS) {
        const label = `${tab} ${vpName} ${theme}`;
        await step(name, 'tabs', label, 'render', async () => {
          if (vpName === 'desktop') {
            // Real tab switching through the sidebar link
            await page.click(`.sidebar a[data-tab="${tab}"]`, { timeout: 5000 });
          } else {
            await page.evaluate(t => { location.hash = '#' + t; }, tab);
          }
          await page.waitForSelector(`#page-${tab}.active`, { timeout: 5000 });
          await page.waitForTimeout(250);
          const m = await pageMetrics(page);
          const shot = path.join(shotDir, `${tab}-${vpName}-${theme}.png`);
          await page.screenshot({ path: shot });
          const errs = takeErrors();
          const unexpected = errs.filter(e => !e.expected);
          record(name, 'tabs', label, 'page is active and has content', m.textLen > 20, { textLen: m.textLen }, shot);
          record(name, 'tabs', label, 'theme class matches', m.dark === (theme === 'dark'), { dark: m.dark }, shot);
          record(name, 'tabs', label, 'no unexpected console errors', unexpected.length === 0, unexpected, shot);
          record(name, 'tabs', label, 'no horizontal page overflow', m.overflowX <= 1, { overflowX: m.overflowX, wide: m.wide }, shot);
          results.push({ engine: name, area: 'expected-errors', page: label, check: 'blocked external loads', ok: true, detail: errs.filter(e => e.expected).map(e => e.text) });
        });
      }
    }
  }
  await page.setViewportSize(VIEWPORTS.desktop);
  await setTheme(page, 'dark');
  await gotoApp(page, 'stocks');
  takeErrors();

  /* 3. Sorting on the Stocks holdings table */
  await step(name, 'sort', 'stocks', 'sort by symbol', async () => {
    const th = '#page-stocks table.holdings th[data-sort-key="symbol"]';
    const read = () => page.evaluate(sel => ({
      aria: document.querySelector(sel).getAttribute('aria-sort'),
      rows: [...document.querySelector(sel).closest('table').tBodies[0].rows].map(r => (r.cells[0] && r.cells[0].innerText || '').trim().split(/\s+/)[0]).filter(Boolean)
    }), th);
    const before = await read();
    await page.click(th + ' button, ' + th);
    await page.waitForTimeout(200);
    const first = await read();
    await page.click(th + ' button, ' + th);
    await page.waitForTimeout(200);
    const second = await read();
    const ok = first.aria !== 'none' && second.aria !== first.aria && JSON.stringify(second.rows) === JSON.stringify([...first.rows].reverse());
    record(name, 'sort', 'stocks', 'header click toggles aria-sort and reverses rows', ok, { before, first, second });
  });

  /* 4. Dialogs, menus and focus return */
  const dialogs = [
    { id: 'add-menu (keyboard)', tab: 'stocks', opener: '#add-btn', dialog: '#add-menu', how: 'keyboard',
      isOpen: () => { const m = document.getElementById('add-menu'); return !!m && !m.hidden; } },
    { id: 'entity modal (keyboard)', tab: 'stocks', opener: '#page-stocks button[data-click="openEntity"][data-a0="stocks"]', dialog: '#entity-modal', how: 'keyboard',
      isOpen: () => document.getElementById('entity-modal').classList.contains('open') },
    { id: 'entity modal (mouse)', tab: 'stocks', opener: '#page-stocks button[data-click="openEntity"][data-a0="stocks"]', dialog: '#entity-modal', how: 'mouse',
      isOpen: () => document.getElementById('entity-modal').classList.contains('open') },
    { id: 'sync details (mouse)', tab: 'dashboard', opener: '.sidebar [data-click="openSyncDetails"]', dialog: '#sync-details-modal', how: 'mouse',
      isOpen: () => document.getElementById('sync-details-modal').classList.contains('open') },
    { id: 'holding panel (mouse)', tab: 'stocks', opener: '#page-stocks table.holdings .sym-btn[data-click="openHolding"]', dialog: '#holding-panel', how: 'mouse',
      isOpen: () => document.getElementById('holding-panel').classList.contains('open') },
    { id: 'command palette (Ctrl+K)', tab: 'dashboard', opener: '#add-btn', dialog: '#cmd-palette', how: 'shortcut',
      isOpen: () => document.getElementById('cmd-palette').classList.contains('open') },
    // F1: Safari-style clicks, the opener never holds focus at the click
    { id: 'entity modal (Safari click)', tab: 'stocks', opener: '#page-stocks button[data-click="openEntity"][data-a0="stocks"]', dialog: '#entity-modal', how: 'safari',
      isOpen: () => document.getElementById('entity-modal').classList.contains('open') },
    { id: '+ Add menu, Stock (Safari click)', tab: 'stocks', opener: '#add-btn', dialog: '#entity-modal', how: 'safari',
      then: '#add-menu [data-click="addMenuPick"][data-a0="stocks"]',
      isOpen: () => document.getElementById('entity-modal').classList.contains('open') },
    { id: 'sync details (Safari click)', tab: 'dashboard', opener: '.sidebar [data-click="openSyncDetails"]', dialog: '#sync-details-modal', how: 'safari',
      isOpen: () => document.getElementById('sync-details-modal').classList.contains('open') },
    { id: 'holding panel (Safari click)', tab: 'stocks', opener: '#page-stocks table.holdings .sym-btn[data-click="openHolding"]', dialog: '#holding-panel', how: 'safari',
      isOpen: () => document.getElementById('holding-panel').classList.contains('open') },
    { id: 'command palette (Safari click)', tab: 'dashboard', opener: '#cp-trigger', dialog: '#cmd-palette', how: 'safari',
      isOpen: () => document.getElementById('cmd-palette').classList.contains('open') },
    { id: 'stock columns (Safari click)', tab: 'stocks', opener: '#btn-stock-cols', dialog: '#stock-cols-modal', how: 'safari',
      isOpen: () => document.getElementById('stock-cols-modal').classList.contains('open') },
    { id: 'setup wizard (Safari click)', tab: 'settings', opener: '#page-settings [data-click="openSetupWizard"]', dialog: '#setup-wizard', how: 'safari',
      isOpen: () => document.getElementById('setup-wizard').classList.contains('open') }
  ];
  for (const d of dialogs) {
    takeErrors(); // errors from an earlier check never land in this one
    await step(name, 'dialogs', d.tab, d.id, async () => {
      await gotoApp(page, d.tab);
      await page.waitForSelector(d.opener, { state: 'visible', timeout: 5000 });
      takeErrors(); // load-time errors belong to the tabs checks, this check counts only what the dialog does
      await markOpener(page, d.opener);
      const r = await dialogRoundTrip(page, {
        opener: d.opener, dialog: d.dialog, isOpen: d.isOpen,
        open: async () => {
          if (d.how === 'keyboard') { await page.focus(d.opener); await page.keyboard.press('Enter'); }
          else if (d.how === 'shortcut') { await page.focus(d.opener); await page.keyboard.press('Control+KeyK'); }
          else if (d.how === 'safari') {
            await safariClick(page, d.opener);
            if (d.then) { await page.waitForSelector(d.then, { state: 'visible', timeout: 5000 }); await safariClick(page, d.then); }
          }
          else await page.click(d.opener);
        }
      });
      const shot = path.join(shotDir, 'dialog-' + d.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png');
      if (!r.opened || !r.focusInside || !r.closedByEscape || !r.focusReturned) await page.screenshot({ path: shot });
      record(name, 'dialogs', d.tab, d.id + ': opens', r.opened, r);
      if (r.opened) {
        record(name, 'dialogs', d.tab, d.id + ': focus moves inside', r.focusInside, r);
        record(name, 'dialogs', d.tab, d.id + ': Escape closes', r.closedByEscape, r);
        record(name, 'dialogs', d.tab, d.id + ': focus returns to the opener', r.focusReturned, r, r.focusReturned ? '' : shot);
      }
      if (d.how === 'mouse') results.push({ engine: name, area: 'dialogs-info', page: d.tab, check: d.id + ': opener held focus at click', ok: true, detail: r.openerFocusedBeforeOpen });
      // The simulation only proves F1 is fixed when the opener really was unfocused at the click
      if (d.how === 'safari') record(name, 'dialogs', d.tab, d.id + ': opener was not focused at the click', !r.openerFocusedBeforeOpen, r);
      const errs = takeErrors().filter(e => !e.expected);
      record(name, 'dialogs', d.tab, d.id + ': no console errors', errs.length === 0, errs);
    });
  }
  // Phone More sheet from the bottom bar, by a real click and by a Safari-style click
  for (const how of ['mouse', 'safari']) {
    const label = how === 'safari' ? 'More sheet (Safari click)' : 'More sheet';
    takeErrors();
    await step(name, 'dialogs', 'phone', label, async () => {
      await page.setViewportSize(VIEWPORTS.phone);
      await gotoApp(page, 'dashboard');
      takeErrors();
      const opener = '.bottom-tab-bar [data-click="openMoreSheet"]';
      const sel = (await page.$(opener)) ? opener : '.bottom-tab-bar button:last-of-type';
      await markOpener(page, sel);
      const r = await dialogRoundTrip(page, { opener: sel, dialog: '#more-sheet', isOpen: () => document.getElementById('more-sheet').classList.contains('open'), open: () => how === 'safari' ? safariClick(page, sel) : page.click(sel) });
      record(name, 'dialogs', 'phone', label + ': opens', r.opened, r);
      if (r.opened) {
        record(name, 'dialogs', 'phone', label + ': Escape closes', r.closedByEscape, r);
        record(name, 'dialogs', 'phone', label + ': focus returns to the opener', r.focusReturned, r);
      }
      if (how === 'safari') record(name, 'dialogs', 'phone', label + ': opener was not focused at the click', !r.openerFocusedBeforeOpen, r);
    });
  }
  await page.setViewportSize(VIEWPORTS.desktop);

  /* 5. Form validation in the Add stock modal */
  await step(name, 'forms', 'stocks', 'Add stock validation', async () => {
    await gotoApp(page, 'stocks');
    await page.click('#page-stocks button[data-click="openEntity"][data-a0="stocks"]');
    await page.waitForSelector('#entity-modal.open', { timeout: 5000 });
    const fields = await page.evaluate(() => [...document.querySelectorAll('#em-body input, #em-body select, #em-body textarea')].map(f => ({ name: f.name || f.id, type: f.type, required: f.required })));
    const toast = async () => {
      await page.waitForTimeout(300);
      return page.evaluate(() => [...document.querySelectorAll('#toast-host .toast')].map(t => t.innerText.trim()).pop() || '');
    };
    await page.click('#entity-modal [data-click="entityModalSave"]');
    const blank = await toast();
    record(name, 'forms', 'stocks', 'blank save shows a Required message', /^Required:/.test(blank), { toast: blank });
    const sym = await page.$('#em-body input[type="text"], #em-body input:not([type])');
    let badSymbol = '';
    if (sym) {
      await sym.fill('!!bad symbol!!');
      // fill every other required numeric field so the symbol rule is what trips
      for (const f of await page.$$('#em-body input[type="number"]')) await f.fill('1');
      await page.click('#entity-modal [data-click="entityModalSave"]');
      badSymbol = await toast();
    }
    record(name, 'forms', 'stocks', 'invalid symbol is refused with a message', /invalid|Required/i.test(badSymbol), { toast: badSymbol });
    const stillOpen = await page.evaluate(() => document.getElementById('entity-modal').classList.contains('open'));
    record(name, 'forms', 'stocks', 'modal stays open after a refused save', stillOpen, {});
    state.formFields = fields;
    state.formToasts = { blank, badSymbol };
    await page.keyboard.press('Escape');
    const count = await page.evaluate(() => DB.stocks.length);
    record(name, 'forms', 'stocks', 'refused saves wrote nothing', count === seedDb.stocks.length, { stocks: count });
  });

  /* 6. Intl formatting, compared to Chromium afterwards */
  await step(name, 'intl', 'all', 'formatting fingerprint', async () => {
    await gotoApp(page, 'dashboard');
    state.intl = await page.evaluate(() => {
      const d = new Date(Date.UTC(2026, 2, 5, 14, 7, 9));
      const nf = (loc, o) => { try { return new Intl.NumberFormat(loc, o).format(1234567.891); } catch (e) { return 'ERR ' + e.message; } };
      const df = (loc, o) => { try { return new Intl.DateTimeFormat(loc, Object.assign({ timeZone: 'Asia/Singapore' }, o)).format(d); } catch (e) { return 'ERR ' + e.message; } };
      return {
        'nf en-SG SGD': nf('en-SG', { style: 'currency', currency: 'SGD' }),
        'nf en-SG USD': nf('en-SG', { style: 'currency', currency: 'USD' }),
        'nf en-SG HKD': nf('en-SG', { style: 'currency', currency: 'HKD' }),
        'nf en-SG compact': nf('en-SG', { notation: 'compact', maximumFractionDigits: 1 }),
        'nf en-SG percent': new Intl.NumberFormat('en-SG', { style: 'percent', maximumFractionDigits: 1 }).format(0.1234),
        'nf en-SG signed': new Intl.NumberFormat('en-SG', { signDisplay: 'exceptZero' }).format(-0.5),
        'toLocaleString en-SG': (1234567.5).toLocaleString('en-SG'),
        'df en-SG medium': df('en-SG', { dateStyle: 'medium' }),
        'df en-SG long': df('en-SG', { dateStyle: 'long', timeStyle: 'short' }),
        'df en-GB weekday': df('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
        'df en-SG month short': df('en-SG', { month: 'short', year: 'numeric' }),
        'rtf en': new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-1, 'day'),
        'app fmt SGD': fmt(1234567.891, { currency: 'SGD' }),
        'app fmt USD': fmt(-9876.5, { currency: 'USD' }),
        'app fmt signed': fmt(42, { currency: 'SGD', signed: true }),
        'app fmtCompact': fmtCompact(3.21e12),
        'app fmtDateSG': fmtDateSG('2026-03-31'),
        'app fmtPct': fmtPct(-1.234),
        'rendered net worth': ((document.querySelector('#page-dashboard .dash-hero') || {}).innerText || '').split('\n').filter(s => /\$/.test(s)).slice(0, 2).join(' | '),
        'rendered date line': ((document.querySelector('#page-dashboard .page-head') || {}).innerText || '').split('\n').find(s => /·/.test(s)) || ''
      };
    });
    // Stocks in USD: the per-tab currency switch exercises USD formatting in a real table
    await gotoApp(page, 'stocks');
    state.intl['rendered stocks row'] = await page.evaluate(() => {
      const r = document.querySelector('#page-stocks table.holdings tbody tr');
      return r ? r.innerText.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    });
  });

  /* 7. CSS features that differ between engines */
  await step(name, 'css', 'all', 'feature probe', async () => {
    await setTheme(page, 'dark');
    await gotoApp(page, 'stocks');
    state.css = await page.evaluate(() => {
      const sup = s => { try { return CSS.supports(s); } catch (_) { return false; } };
      const cs = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).getPropertyValue(prop) : 'missing'; };
      return {
        'theme is dark': document.documentElement.classList.contains('dark'),
        'supports :has()': sup('selector(:has(a))'),
        'supports backdrop-filter': sup('backdrop-filter: blur(1px)'),
        'supports -webkit-backdrop-filter': sup('-webkit-backdrop-filter: blur(1px)'),
        'supports color-mix': sup('color: color-mix(in srgb, red 50%, blue)'),
        'supports subgrid': sup('grid-template-columns: subgrid'),
        'supports 100dvh': sup('height: 100dvh'),
        'supports scrollbar-width': sup('scrollbar-width: thin'),
        'supports :focus-visible': sup('selector(:focus-visible)'),
        'supports scroll-snap-type': sup('scroll-snap-type: x mandatory'),
        'HTMLDialogElement': typeof HTMLDialogElement === 'function',
        'inert property': 'inert' in HTMLElement.prototype,
        'topbar backdrop-filter': cs('.topbar', 'backdrop-filter') || cs('.topbar', '-webkit-backdrop-filter'),
        'topbar -webkit-backdrop-filter': cs('.topbar', '-webkit-backdrop-filter'),
        'sidebar position': cs('.sidebar', 'position'),
        'topbar position': cs('.topbar', 'position'),
        'sticky-col position': cs('#page-stocks table.holdings th.sticky-col', 'position'),
        'color-mix resolves (--c-stocks-soft)': getComputedStyle(document.documentElement).getPropertyValue('--c-stocks-soft').trim().slice(0, 60),
        'font family': cs('body', 'font-family'),
        'uses scroll snap anywhere': [...document.querySelectorAll('*')].some(e => { const v = getComputedStyle(e).scrollSnapType; return v && v !== 'none'; })
      };
    });
    // Sticky top bar: scroll the page, the bar must stay at the top
    const sticky = await page.evaluate(async () => {
      window.scrollTo(0, 800);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const t = document.querySelector('.topbar').getBoundingClientRect().top;
      const s = document.querySelector('.sidebar').getBoundingClientRect().top;
      window.scrollTo(0, 0);
      return { topbarTop: Math.round(t), sidebarTop: Math.round(s), scrolled: document.scrollingElement.scrollHeight > innerHeight };
    });
    state.css['sticky after scroll'] = sticky;
    record(name, 'css', 'stocks', 'top bar and sidebar stay pinned on scroll', !sticky.scrolled || (sticky.topbarTop === 0 && sticky.sidebarTop === 0), sticky);
    // Modal backdrop blur while a modal is open
    await page.click('#page-stocks button[data-click="openEntity"][data-a0="stocks"]');
    await page.waitForSelector('#entity-modal.open', { timeout: 5000 });
    state.css['overlay backdrop-filter'] = await page.evaluate(() => { const s = getComputedStyle(document.getElementById('entity-modal')); return s.backdropFilter || s.webkitBackdropFilter || 'none'; });
    state.css['modal backdrop-filter'] = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('#entity-modal .modal')); return s.backdropFilter || s.webkitBackdropFilter || 'none'; });
    await page.screenshot({ path: path.join(shotDir, 'css-modal-open.png') });
    await page.keyboard.press('Escape');
    // :has() drives the compact page head rule. Check it matched where it should
    state.css[':has() rule applies'] = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('.page-head')];
      return heads.some(h => h.matches(':not(:has(> :not(.ph-text)))'));
    }).catch(e => 'ERR ' + e.message);
    takeErrors();
  });

  /* 8. Service worker, then an offline reload with the server really gone. The worker installs from a throwaway
        server of the script's own, the script closes that server and the page reloads, so only the worker can
        answer. context.setOffline(true) is not used, because Firefox throws NS_ERROR_OFFLINE on the reload before
        the worker is asked (F6). The same path runs in all three engines. The page leaves the --base origin here,
        so that origin's storage is read for the safety check first. */
  const baseSafety = await storageSafety(page);
  let swSafety = {};
  const swChecks = async site => {
    const swUrl = site.origin + '/Portfolio/';
    const served = await probeUrl(swUrl);
    if (served !== 'HTTP 200') throw new Error(`the throwaway server gave ${served} for ${swUrl}`);
    await gotoApp(page, 'dashboard', swUrl);
    const reg = await page.evaluate(() => Promise.race([
      navigator.serviceWorker ? navigator.serviceWorker.ready.then(r => ({ active: !!r.active, scope: r.scope })) : Promise.resolve({ active: false, scope: 'no serviceWorker API' }),
      new Promise(r => setTimeout(() => r({ active: false, scope: 'timeout' }), 10000))
    ]));
    record(name, 'sw', 'dashboard', 'service worker registers and activates', reg.active, reg);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(800);
    const ctl = await page.evaluate(async () => ({
      controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      caches: await caches.keys(),
      entries: await (async () => { const k = (await caches.keys()).find(n => n.startsWith('kjr-portfolio-')); return k ? (await (await caches.open(k)).keys()).map(r => r.url.replace(location.origin, '')) : []; })()
    }));
    record(name, 'sw', 'dashboard', 'page is controlled after reload', ctl.controlled, { caches: ctl.caches, entries: ctl.entries.length });
    const online = await page.evaluate(() => (document.querySelector('#page-dashboard .dash-hero') || {}).innerText || '');
    takeErrors();
    // The server goes away for real, open connections included. The probe then proves nothing answers, and the
    // three offline checks below cannot pass unless it did.
    await site.close();
    const gone = await probeUrl(swUrl);
    const serverDown = gone.startsWith('down');
    let offline = { ok: false };
    try {
      await page.reload({ waitUntil: 'load', timeout: 15000 });
      await page.waitForSelector('#page-dashboard', { state: 'attached', timeout: 10000 });
      await page.waitForTimeout(800);
      offline = await page.evaluate(() => ({
        ok: !!document.querySelector('#page-dashboard.active'),
        hero: (document.querySelector('#page-dashboard .dash-hero') || {}).innerText || '',
        navCount: document.querySelectorAll('.sidebar a[data-tab]').length
      }));
    } catch (e) { offline.error = String(e.message || e).split('\n')[0]; }
    const shot = path.join(shotDir, 'offline-reload.png');
    await page.screenshot({ path: shot }).catch(() => {});
    const rendered = serverDown && offline.ok && offline.navCount === TABS.length;
    record(name, 'sw', 'dashboard', 'offline reload renders the dashboard from cache', rendered, { ...offline, server: gone }, rendered ? '' : shot);
    record(name, 'sw', 'dashboard', 'offline figures match online', serverDown && offline.ok && offline.hero.split('\n').slice(0, 4).join() === online.split('\n').slice(0, 4).join(), { online: online.slice(0, 120), offline: (offline.hero || '').slice(0, 120), server: gone });
    const errs = takeErrors().filter(e => !e.expected);
    record(name, 'sw', 'dashboard', 'no console errors offline', serverDown && errs.length === 0, serverDown ? errs : { server: gone, errs });
  };
  await step(name, 'sw', 'dashboard', 'service worker and offline reload', async () => {
    const site = await startStaticServer(REPO_ROOT);
    // finally: the server is closed and the worker origin's storage is read even when a check threw
    try { await swChecks(site); } finally { await site.close(); swSafety = await storageSafety(page); }
  });

  /* 9. Safety: nothing switched the backend or stored a sync URL, on the --base origin or on the worker's */
  if (unsafeStorage(baseSafety) || unsafeStorage(swSafety)) {
    console.error(`[${name}] SAFETY: a sync URL or NAS mode appeared in storage, aborting.`, { base: baseSafety, serviceWorkerOrigin: swSafety });
    await browser.close();
    process.exit(2);
  }
  await browser.close();
}

/* ── compare engines with the Chromium baseline ────────────────────────── */
function compare() {
  const base = engineState.chromium;
  const diffs = [];
  if (!base || !base.launched) return diffs;
  for (const e of ENGINES.filter(e => e !== 'chromium')) {
    const s = engineState[e];
    if (!s || !s.launched) continue;
    for (const group of ['intl', 'css']) {
      for (const [k, v] of Object.entries(base[group] || {})) {
        const other = (s[group] || {})[k];
        if (JSON.stringify(other) !== JSON.stringify(v)) diffs.push({ engine: e, group, key: k, chromium: v, [e]: other });
      }
    }
    if (JSON.stringify(s.formToasts) !== JSON.stringify(base.formToasts)) diffs.push({ engine: e, group: 'forms', key: 'validation toasts', chromium: base.formToasts, [e]: s.formToasts });
  }
  return diffs;
}

/* ── self-test, no browser ─────────────────────────────────────────────── */
/* 1. The expected-error filter, against the wording each engine really used. */
function filterCases(check) {
  const cases = [
    ['console', 'Failed to preconnect to https://fonts.gstatic.com/', '', true],                       // WebKit, Mac run
    ['console', 'Failed to preconnect to https://cdn.jsdelivr.net/', '', true],
    ['console', 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT', 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js', true],
    ['console', 'Failed to load resource: The network connection was lost.', 'https://fonts.googleapis.com/css2?family=Manrope', true],
    ['console', 'Failed to preconnect to http://localhost:3807/', '', false],
    ['console', 'Failed to load resource: the server responded with a status of 404 (Not Found)', 'http://localhost:3807/Portfolio/Worker/app.js', false],
    ['console', 'TypeError: undefined is not an object (evaluating \'DB.stocks\')', 'http://localhost:3807/Portfolio/Worker/app.js', false],
    ['pageerror', 'TypeError: Load failed', true, true],                                                 // F5, WebKit
    ['pageerror', 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js', true, true],      // F5, WebKit
    ['pageerror', '/cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js.', true, true],            // F5, WebKit 27.2 on the Mac, as Playwright 1.64.0 delivers it
    ['pageerror', '/cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js.', false, false],          // nothing was blocked, so it is real
    ['pageerror', 'TypeError: Load failed', false, false],                                               // nothing was blocked, so it is real
    ['pageerror', 'http://localhost:3807/Portfolio/Worker/app.js', true, false],
    ['pageerror', '/localhost:3807/Portfolio/Worker/app.js.', true, false],                              // app origin in the same scheme-less shape
    ['pageerror', '/127.0.0.1:3807/Portfolio/Worker/app.js.', true, false],
    ['pageerror', '/sw.js', true, false],                                                                // a file name is not a host
    ['pageerror', 'ReferenceError: Chart is not defined', true, false]
  ];
  for (const [kind, text, extra, want] of cases) {
    const got = kind === 'console' ? isExpectedConsoleError(text, extra) : isExpectedPageError(text, extra);
    check('Filter', kind + ' ' + JSON.stringify(text), got, want);
  }
}

/* 2. The throwaway server's path guard, then real requests to a server on a fixture tree, then its shutdown. The
      tree has a file outside the root, a sibling folder that shares the root's name as a prefix, dot paths, symlinks
      in and out, and a git-ignored file type. */
async function serverGuardCases(check) {
  const G = 'Server guard';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kjr-static-selftest-'));
  let site = null;
  try {
    const root = path.join(tmp, 'root');
    const put = (rel, text = 'ok') => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
    put('root/index.html', '<title>root</title>');
    put('root/Portfolio/index.html', '<title>app</title>');
    put('root/Portfolio/app.js');
    put('root/Portfolio/Docs/Exposure.xlsx');
    put('root/.git/config.json', '{}');
    put('root/.env.json', '{}');
    put('outside.json', '{}');
    put('root-evil/secret.json', '{}');
    let links = true;
    try {
      fs.symlinkSync(path.join(tmp, 'outside.json'), path.join(root, 'Portfolio', 'link-out.json'));
      fs.symlinkSync(path.join(tmp, 'root-evil'), path.join(root, 'link-dir'));
      fs.symlinkSync(path.join(root, 'Portfolio', 'app.js'), path.join(root, 'Portfolio', 'link-in.js'));
      fs.symlinkSync(path.join(root, 'Portfolio', 'Docs', 'Exposure.xlsx'), path.join(root, 'Portfolio', 'link-xlsx.js'));
    } catch (e) { links = false; console.log(`  note: symlinks cannot be made here (${e.code}), the symlink cases are skipped`); }
    const real = fs.realpathSync(root);
    const answer = t => { const r = resolveStaticTarget(real, t); return r.status === 200 ? path.relative(real, r.file).split(path.sep).join('/') : r.status; };
    const cases = [
      // served
      ['/', 'index.html'], ['/index.html', 'index.html'], ['/Portfolio/', 'Portfolio/index.html'],
      ['/Portfolio/app.js?v=2.89', 'Portfolio/app.js'], ['/Portfolio/app.js#top', 'Portfolio/app.js'], ['/Portfolio/%61pp.js', 'Portfolio/app.js'],
      // not there, or not a served type
      ['/Portfolio', 404], ['/Portfolio/missing.js', 404], ['/Portfolio/Docs/', 404], ['/Portfolio/Docs/Exposure.xlsx', 404],
      // traversal, plain and encoded, and the sibling that shares the root's name as a prefix
      ['/../outside.json', 403], ['/%2e%2e/outside.json', 403], ['/%2E%2E/outside.json', 403],
      ['/Portfolio/../../outside.json', 403], ['/Portfolio/%2e%2e/%2e%2e/outside.json', 403],
      ['/..%2foutside.json', 403], ['/Portfolio/..%2f..%2foutside.json', 403], ['/%2e%2e%2foutside.json', 403],
      ['/../root-evil/secret.json', 403], ['/..%2froot-evil/secret.json', 403], ['/Portfolio/./app.js', 403],
      // dot paths
      ['/.git/config.json', 403], ['/.env.json', 403],
      // malformed
      ['/%00', 400], ['/Portfolio/app.js%00.html', 400], ['/..%5coutside.json', 400], ['/%E0%A4%A', 400],
      ['http://evil.test/Portfolio/', 400], ['', 400], ['*', 400]
    ];
    if (links) cases.push(
      ['/Portfolio/link-in.js', 'Portfolio/app.js'], // a symlink that stays inside the root is fine
      ['/Portfolio/link-out.json', 403], ['/link-dir/secret.json', 403], // a symlink that leaves the root is not
      ['/Portfolio/link-xlsx.js', 404]); // and a symlink cannot smuggle in a type that is not served
    for (const [t, want] of cases) check(G, JSON.stringify(t), answer(t), want);

    site = await startStaticServer(root);
    const call = (method, target) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: site.port, method, path: target, agent: false }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, h: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      r.on('error', reject);
      r.end();
    });
    const page = await call('GET', '/Portfolio/');
    check(G, 'GET a folder serves its index.html', [page.status, page.body, page.h['content-type'], page.h['x-content-type-options']], [200, '<title>app</title>', 'text/html; charset=utf-8', 'nosniff']);
    const js = await call('GET', '/Portfolio/app.js?v=1');
    check(G, 'GET a script', [js.status, js.h['content-type'], js.body], [200, 'text/javascript; charset=utf-8', 'ok']);
    const head = await call('HEAD', '/Portfolio/app.js');
    check(G, 'HEAD sends the headers and no body', [head.status, head.h['content-length'], head.body], [200, '2', '']);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await call(m, '/Portfolio/app.js');
      check(G, m + ' is refused', [r.status, r.h.allow], [405, 'GET, HEAD']);
    }
    for (const t of ['/../outside.json', '/%2e%2e/outside.json', '/Portfolio/..%2f..%2foutside.json', '/.git/config.json']) {
      const r = await call('GET', t); // raw targets: http.request sends them as written
      check(G, 'over HTTP ' + JSON.stringify(t), [r.status, r.body.includes('{}')], [403, false]);
    }
    // close() drops an idle kept-alive connection, can be called twice, and leaves nothing listening or registered
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const sock = await new Promise((resolve, reject) => { // res.socket is detached by the time 'end' fires, so take it first
      http.get({ host: '127.0.0.1', port: site.port, path: '/Portfolio/app.js', agent }, res => { const s = res.socket; res.resume(); res.on('end', () => resolve(s)); }).on('error', reject);
    });
    const dropped = new Promise(resolve => sock.once('close', () => resolve(true)));
    const url = site.origin + '/Portfolio/';
    check(G, 'the server is registered for the exit paths while it runs', cleanups.size, 1);
    await site.close();
    await site.close();
    check(G, 'close() drops a kept-alive connection', await Promise.race([dropped, sleep(2000).then(() => false)]), true);
    agent.destroy();
    check(G, 'nothing listens after close()', await probeUrl(url), 'down (ECONNREFUSED)');
    check(G, 'a closed server leaves nothing registered', cleanups.size, 0);
  } finally {
    if (site) await site.close();
    fs.rmSync(tmp, { recursive: true, force: true }); // removes symlinks themselves, never what they point at
  }
}

/* 3. The Firefox home rule. */
function firefoxHomeCases(check) {
  const G = 'Firefox home';
  const envBefore = process.env.CFFIXED_USER_HOME;
  check(G, 'Firefox on macOS, variable unset', needsFirefoxHome('firefox', 'darwin', {}), true);
  check(G, 'an empty value counts as unset', needsFirefoxHome('firefox', 'darwin', { CFFIXED_USER_HOME: '' }), true);
  check(G, 'a value the caller set is left alone', needsFirefoxHome('firefox', 'darwin', { CFFIXED_USER_HOME: '/tmp/mine' }), false);
  check(G, 'Linux is left alone', needsFirefoxHome('firefox', 'linux', {}), false);
  check(G, 'Windows is left alone', needsFirefoxHome('firefox', 'win32', {}), false);
  check(G, 'WebKit is left alone', needsFirefoxHome('webkit', 'darwin', {}), false);
  check(G, 'Chromium is left alone', needsFirefoxHome('chromium', 'darwin', {}), false);
  check(G, 'no folder is made when none is needed', [makeFirefoxHome('webkit', 'darwin', {}), makeFirefoxHome('firefox', 'darwin', { CFFIXED_USER_HOME: '/tmp/mine' })], [null, null]);
  const home = makeFirefoxHome('firefox', 'darwin', { PATH: '/usr/bin', KEEP: 'yes' });
  let writable = false;
  try { fs.accessSync(home.dir, fs.constants.W_OK); writable = true; } catch (_) {}
  check(G, 'the folder is empty and writable', [fs.readdirSync(home.dir), writable], [[], true]);
  check(G, 'the launch env keeps the rest and adds the variable', [home.env.PATH, home.env.KEEP, home.env.CFFIXED_USER_HOME === home.dir], ['/usr/bin', 'yes', true]);
  check(G, 'the folder is registered for the exit paths', cleanups.size, 1);
  check(G, 'remove() deletes it, and twice is harmless', [home.remove(), home.remove(), fs.existsSync(home.dir)], [true, true, false]);
  check(G, 'a removed folder leaves nothing registered', cleanups.size, 0);
  // The real failure: macOS marks Library and the folders under it "deny delete", and a plain rm leaves them behind
  if (process.platform === 'darwin') {
    const h = makeFirefoxHome('firefox', 'darwin', {});
    const lib = path.join(h.dir, 'Library'), sup = path.join(lib, 'Application Support');
    fs.mkdirSync(sup, { recursive: true });
    let acl = true;
    try { execFileSync('chmod', ['+a', 'group:everyone deny delete', sup, lib], { stdio: 'ignore' }); } catch (_) { acl = false; }
    if (acl) check(G, 'remove() clears folders that macOS protects with a deny-delete ACL', [h.remove(), fs.existsSync(h.dir)], [true, false]);
    else { console.log('  note: could not set a deny-delete ACL here, that case is skipped'); h.remove(); }
  }
  check(G, 'process.env is not changed', process.env.CFFIXED_USER_HOME, envBefore);
}

async function selfTest() {
  const groups = {};
  const check = (group, label, got, want) => {
    const g = groups[group] = groups[group] || { total: 0, bad: 0 };
    g.total++;
    if (JSON.stringify(got) !== JSON.stringify(want)) { g.bad++; console.log(`  FAIL ${group}, ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
  };
  filterCases(check);
  await serverGuardCases(check);
  firefoxHomeCases(check);
  let total = 0, bad = 0;
  for (const [group, g] of Object.entries(groups)) {
    console.log(`${group} self-test: ${g.total - g.bad} of ${g.total} passed.`);
    total += g.total; bad += g.bad;
  }
  console.log(`Self-test: ${total - bad} of ${total} passed.`);
  process.exit(bad ? 1 : 0);
}

/* ── main ──────────────────────────────────────────────────────────────── */
(async () => {
  if (args['self-test']) return selfTest();
  try {
    const res = await fetch(APP_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) {
    console.error(`Dev server not reachable at ${APP_URL} (${e.message}). From the repo root run: npx serve -l 3807 .`);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const proxy = await startBlackHole();
  const port = proxy.address().port;
  for (const name of ENGINES) {
    const ffHome = makeFirefoxHome(name); // null unless this is Firefox on macOS with CFFIXED_USER_HOME unset
    if (ffHome) console.log(`[${name}] CFFIXED_USER_HOME is unset, launching with an empty temp home (removed at the end)`);
    try { await runEngine(name, port, ffHome); } catch (e) {
      engineState[name] = Object.assign(engineState[name] || {}, { crashed: String(e && e.stack || e).slice(0, 500) });
      record(name, 'run', '-', 'engine pass completed', false, String(e && e.message || e));
    } finally { if (ffHome && !ffHome.remove()) console.log(`[${name}] could not remove ${ffHome.dir}, one more try runs at exit`); }
  }
  proxy.close();
  const diffs = compare();
  const failures = results.filter(r => !r.ok);
  const report = {
    when: new Date().toISOString(), base: APP_URL, engines: ENGINES, playwright: (() => { try { return createRequire(import.meta.url)(path.join(path.dirname(createRequire(import.meta.url).resolve(process.env.KJR_PLAYWRIGHT || 'playwright')), 'package.json')).version; } catch (_) { return 'unknown'; } })(),
    engineState, blocked, diffs, failures, results
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\nSummary');
  for (const e of ENGINES) {
    const s = engineState[e] || {};
    const mine = results.filter(r => r.engine === e && r.area !== 'expected-errors' && r.area !== 'dialogs-info');
    console.log(`- ${e}: ${s.launched ? s.version : 'not run (' + (s.error || 'unknown') + ')'}, ${mine.filter(r => r.ok).length}/${mine.length} checks passed`);
  }
  console.log(`- differences from Chromium: ${diffs.length}`);
  for (const d of diffs) console.log(`  ${d.engine} ${d.group} ${d.key}: chromium=${JSON.stringify(d.chromium)} ${d.engine}=${JSON.stringify(d[d.engine])}`);
  console.log(`- blocked outbound URLs: ${blocked.length}`);
  for (const b of blocked) console.log(`  [${b.engine} ${b.via}] ${b.url}`);
  console.log(`- report: ${path.join(OUT, 'report.json')}`);
  const notRun = ENGINES.some(e => !(engineState[e] || {}).launched);
  process.exit(failures.length || notRun ? 1 : 0);
})();
