/* Focused service-worker tests for cache ownership and HTML navigation caches. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const BASE = 'https://app.test/Portfolio/';
const CURRENT_CACHE = SOURCE.match(/const CACHE_NAME = '([^']+)'/)[1];

class NavigationRequest {
  constructor(url) {
    this.url = url;
    this.method = 'GET';
    this.mode = 'navigate';
    this.headers = { get: name => name.toLowerCase() === 'accept' ? 'text/html' : null };
  }
}

function createHarness(options = {}) {
  const entries = new Map();
  const listeners = new Map();
  let fetchImpl = () => Promise.reject(new Error('network unavailable'));
  const putControl = options.putControl || null;
  const putError = options.putError || null;
  const cacheNames = new Set(options.cacheNames || [CURRENT_CACHE]);
  const deletedCaches = [];
  let clientsClaimed = false;

  function keyFor(request) {
    const value = typeof request === 'string' ? request : request.url;
    return new URL(value, BASE + 'sw.js').toString();
  }

  const cache = {
    async put(request, response) {
      if (putControl) {
        putControl.started = true;
        await putControl.promise;
      }
      if (putError) throw putError;
      entries.set(keyFor(request), response.clone());
      if (putControl) putControl.finished = true;
    },
    match(request) {
      const response = entries.get(keyFor(request));
      return Promise.resolve(response ? response.clone() : undefined);
    }
  };

  const caches = {
    open() { return Promise.resolve(cache); },
    match(request) { return cache.match(request); },
    keys() { return Promise.resolve([...cacheNames]); },
    delete(name) {
      deletedCaches.push(name);
      return Promise.resolve(cacheNames.delete(name));
    }
  };

  const self = {
    location: { href: BASE + 'sw.js', origin: new URL(BASE).origin },
    clients: { claim() { clientsClaimed = true; return Promise.resolve(); } },
    skipWaiting() { return Promise.resolve(); },
    addEventListener(type, handler) { listeners.set(type, handler); }
  };

  const context = {
    self,
    caches,
    URL,
    Response,
    Promise,
    Map,
    Set,
    console,
    fetch(request) { return fetchImpl(request); }
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'sw.js' });

  return {
    async activate() {
      let activation;
      listeners.get('activate')({ waitUntil(promise) { activation = promise; } });
      await activation;
    },
    cacheNames() { return [...cacheNames]; },
    deletedCaches() { return [...deletedCaches]; },
    clientsClaimed() { return clientsClaimed; },
    queue(responseOrError) {
      fetchImpl = () => responseOrError instanceof Error
        ? Promise.reject(responseOrError)
        : Promise.resolve(responseOrError);
    },
    async navigate(url) {
      const event = { request: new NavigationRequest(url), responsePromise: null };
      event.respondWith = promise => { event.responsePromise = Promise.resolve(promise); };
      listeners.get('fetch')(event);
      return event.responsePromise;
    },
    async cached(url) {
      return cache.match(new NavigationRequest(url));
    }
  };
}

function onlineBody(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
}

async function body(response) {
  return response ? response.text() : '';
}

async function run() {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log('PASS: ' + name);
      passed++;
    } catch (error) {
      console.error('FAIL: ' + name);
      console.error(error && error.stack ? error.stack : error);
      failed++;
    }
  }

  await test('activation deletes only old Portfolio caches and preserves sibling app caches', async () => {
    const preserved = [CURRENT_CACHE, 'kjr-forex-v0.13', 'kjr-trading-v1', 'unrelated-cache', 'kjr-portfolios-v1'];
    const retired = ['kjr-portfolio-v2.65', 'kjr-portfolio-v2.67'];
    const harness = createHarness({ cacheNames: [...preserved, ...retired] });

    await harness.activate();

    assert.deepEqual(harness.deletedCaches().sort(), retired.sort());
    assert.deepEqual(harness.cacheNames().sort(), preserved.sort());
    assert.equal(harness.clientsClaimed(), true);
  });

  await test('activation with no old Portfolio cache leaves all origin caches intact', async () => {
    const preserved = [CURRENT_CACHE, 'kjr-forex-v0.13', 'site-assets'];
    const harness = createHarness({ cacheNames: preserved });

    await harness.activate();

    assert.deepEqual(harness.deletedCaches(), []);
    assert.deepEqual(harness.cacheNames(), preserved);
    assert.equal(harness.clientsClaimed(), true);
  });

  await test('main and pilot online visits keep request-specific cached documents', async () => {
    const harness = createHarness();
    const mainUrl = BASE + 'index.html';
    const pilotUrl = BASE + 'decision-notes-pilot.html';

    harness.queue(onlineBody('MAIN ONLINE'));
    assert.equal(await body(await harness.navigate(mainUrl)), 'MAIN ONLINE');
    harness.queue(onlineBody('PILOT ONLINE'));
    assert.equal(await body(await harness.navigate(pilotUrl)), 'PILOT ONLINE');

    assert.equal(await body(await harness.cached(mainUrl)), 'MAIN ONLINE');
    assert.equal(await body(await harness.cached(pilotUrl)), 'PILOT ONLINE');
  });

  await test('main and pilot offline visits return their own cached documents', async () => {
    const harness = createHarness();
    const mainUrl = BASE + 'index.html';
    const pilotUrl = BASE + 'decision-notes-pilot.html';

    harness.queue(onlineBody('MAIN ONLINE'));
    await harness.navigate(mainUrl);
    harness.queue(onlineBody('PILOT ONLINE'));
    await harness.navigate(pilotUrl);

    harness.queue(new Error('offline'));
    assert.equal(await body(await harness.navigate(mainUrl)), 'MAIN ONLINE');
    harness.queue(new Error('offline'));
    assert.equal(await body(await harness.navigate(pilotUrl)), 'PILOT ONLINE');
  });

  await test('uncached pilot and query variants never fall back to the main app shell', async () => {
    const harness = createHarness();
    const mainUrl = BASE + 'index.html';
    const pilotUrl = BASE + 'decision-notes-pilot.html?uncached=1';

    harness.queue(onlineBody('MAIN ONLINE'));
    await harness.navigate(mainUrl);
    harness.queue(new Error('offline'));
    const response = await harness.navigate(pilotUrl);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    assert.match(await body(response), /this document is not cached/i);
    assert.doesNotMatch(await body(await harness.cached(mainUrl)), /PILOT/);
  });

  await test('uncached main and pilot responses preserve UTF-8 offline text', async () => {
    const harness = createHarness();
    const mainUrl = BASE + 'index.html?uncached=1';
    const pilotUrl = BASE + 'decision-notes-pilot.html?uncached=1';

    harness.queue(new Error('offline'));
    const mainResponse = await harness.navigate(mainUrl);
    assert.equal(mainResponse.status, 503);
    assert.equal(mainResponse.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    assert.equal(await body(mainResponse), 'Offline — open the app while connected to cache it first.');

    harness.queue(new Error('offline'));
    const pilotResponse = await harness.navigate(pilotUrl);
    assert.equal(pilotResponse.status, 503);
    assert.equal(pilotResponse.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    assert.equal(await body(pilotResponse), 'Offline — this document is not cached yet. Open it while connected to cache it first.');
  });

  await test('non-OK navigation responses are returned and do not replace a good cache', async () => {
    const harness = createHarness();
    const mainUrl = BASE + 'index.html';
    const pilotUrl = BASE + 'decision-notes-pilot.html';

    harness.queue(onlineBody('MAIN ONLINE'));
    await harness.navigate(mainUrl);
    harness.queue(onlineBody('MAIN ERROR', 503));
    const mainError = await harness.navigate(mainUrl);
    assert.equal(mainError.status, 503);
    harness.queue(new Error('offline'));
    assert.equal(await body(await harness.navigate(mainUrl)), 'MAIN ONLINE');

    harness.queue(onlineBody('PILOT ONLINE'));
    await harness.navigate(pilotUrl);
    harness.queue(onlineBody('PILOT ERROR', 503));
    const pilotError = await harness.navigate(pilotUrl);
    assert.equal(pilotError.status, 503);
    harness.queue(new Error('offline'));
    assert.equal(await body(await harness.navigate(pilotUrl)), 'PILOT ONLINE');
  });

  await test('navigation response waits for the requested-document cache write', async () => {
    let release;
    const putControl = {
      started: false,
      finished: false,
      promise: new Promise(resolve => { release = resolve; })
    };
    const harness = createHarness({ putControl });
    const mainUrl = BASE + 'index.html';
    harness.queue(onlineBody('MAIN ONLINE'));
    const navigation = harness.navigate(mainUrl);
    for (let attempt = 0; attempt < 10 && !putControl.started; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(putControl.started, true);
    let settled = false;
    navigation.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    release();
    assert.equal(await body(await navigation), 'MAIN ONLINE');
    assert.equal(putControl.finished, true);
  });

  await test('a rejected cache write still returns the fresh network response', async () => {
    const harness = createHarness({ putError: new Error('cache unavailable') });
    const mainUrl = BASE + 'index.html';
    harness.queue(onlineBody('MAIN ONLINE'));
    const response = await harness.navigate(mainUrl);
    assert.equal(response.status, 200);
    assert.equal(await body(response), 'MAIN ONLINE');
    assert.equal(await harness.cached(mainUrl), undefined);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
