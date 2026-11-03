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
 *   --base=http://localhost:3807        dev server origin, must be localhost or 127.0.0.1
 *   --out=<dir>                         report and screenshots (default <tmp>/kjr-browser-qa)
 *   --chromium-path=<file>              Chromium binary override (env KJR_CHROMIUM_PATH)
 *   --headed                            show the browser windows
 *   --self-test                         check the expected-error filter against known engine wording, no browser
 * Env KJR_PLAYWRIGHT=<path to the playwright package> if it is not resolvable.
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
 *   The run aborts if either appears in storage.
 * - Exit code 0 when every engine that launched passed every check, 1 when a
 *   check failed or an engine could not launch, 2 on a safety violation.
 */

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
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
   - WebKit page errors (F5, the service worker's cache-first fetch fails): "TypeError: Load failed" and a bare
     external URL, both with no stack
   A page error counts as expected only when this engine has had a request blocked already, so a real
   "Load failed" from a localhost fetch with no block behind it still fails the check. */
const EXTERNAL_IN_TEXT = /https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])[^\s'"]+/i;
const BLOCKED_WORDING = /chart\.js|fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|integrity|blocked|preconnect|failed to load|load failed|access control|net::ERR_/i;
function isExpectedConsoleError(text, locUrl) {
  return isExternalUrl(locUrl) || (EXTERNAL_IN_TEXT.test(text) && BLOCKED_WORDING.test(text));
}
function isExpectedPageError(message, hadBlockedLoad) {
  const m = String(message || '').trim();
  if (!hadBlockedLoad) return false;
  return m === 'TypeError: Load failed' || m === 'Load failed' || (isExternalUrl(m) && !/\s/.test(m));
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
   would keep its old theme and state. A marker on the old document shows when that happened, and a reload follows. */
async function gotoApp(page, hash) {
  await page.evaluate(() => { window.__kjrQaOldDocument = true; }).catch(() => {});
  await page.goto(APP_URL + (hash ? '#' + hash : ''), { waitUntil: 'load' });
  if (await page.evaluate(() => window.__kjrQaOldDocument === true).catch(() => false)) await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#page-dashboard', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(600); // whenIdle engines and the first renderAll
}
async function setTheme(page, theme) {
  await page.evaluate(([k, t]) => localStorage.setItem(k, t), [LK.theme, theme]);
}
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
async function runEngine(name, proxyPort) {
  const state = engineState[name] = { launched: false };
  proxyEngine = name;
  const launchOpts = {
    headless: !args.headed,
    proxy: { server: 'http://127.0.0.1:' + proxyPort, bypass: 'localhost,127.0.0.1' }
  };
  if (name === 'chromium' && CHROMIUM_PATH) launchOpts.executablePath = CHROMIUM_PATH;
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

  /* 8. Service worker registration and an offline reload */
  await step(name, 'sw', 'dashboard', 'service worker and offline reload', async () => {
    await gotoApp(page, 'dashboard');
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
    await context.setOffline(true);
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
    record(name, 'sw', 'dashboard', 'offline reload renders the dashboard from cache', offline.ok && offline.navCount === TABS.length, offline, offline.ok ? '' : shot);
    record(name, 'sw', 'dashboard', 'offline figures match online', offline.ok && offline.hero.split('\n').slice(0, 4).join() === online.split('\n').slice(0, 4).join(), { online: online.slice(0, 120), offline: (offline.hero || '').slice(0, 120) });
    const errs = takeErrors().filter(e => !e.expected);
    record(name, 'sw', 'dashboard', 'no console errors offline', errs.length === 0, errs);
    await context.setOffline(false);
  });

  /* 9. Safety: nothing switched the backend or stored a sync URL */
  const safety = await page.evaluate(lk => ({ syncUrl: localStorage.getItem(lk.syncUrl), backend: localStorage.getItem(lk.backend) }), LK).catch(() => ({}));
  if (safety.syncUrl || safety.backend === 'nas') {
    console.error(`[${name}] SAFETY: a sync URL or NAS mode appeared in storage, aborting.`, safety);
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

/* ── self-test: the expected-error filter, against the wording each engine really used ── */
function selfTest() {
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
    ['pageerror', 'TypeError: Load failed', false, false],                                               // nothing was blocked, so it is real
    ['pageerror', 'http://localhost:3807/Portfolio/Worker/app.js', true, false],
    ['pageerror', 'ReferenceError: Chart is not defined', true, false]
  ];
  let bad = 0;
  for (const [kind, text, extra, want] of cases) {
    const got = kind === 'console' ? isExpectedConsoleError(text, extra) : isExpectedPageError(text, extra);
    if (got !== want) { bad++; console.log(`  FAIL ${kind} ${JSON.stringify(text)}: expected=${got}, want ${want}`); }
  }
  console.log(`Filter self-test: ${cases.length - bad} of ${cases.length} passed.`);
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
    try { await runEngine(name, port); } catch (e) {
      engineState[name] = Object.assign(engineState[name] || {}, { crashed: String(e && e.stack || e).slice(0, 500) });
      record(name, 'run', '-', 'engine pass completed', false, String(e && e.message || e));
    }
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
