/* Node tests for the optional encrypted browser vault. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { createManager, parseEnvelope } = require('../Worker/kjr-vault.js');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'Worker', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

class FakeStorage {
  constructor(seed) {
    this._data = new Map(Object.entries(seed || {}).map(([k, v]) => [k, String(v)]));
    this.failEnvelopeWrites = false;
  }
  get length() { return this._data.size; }
  key(index) { return Array.from(this._data.keys())[index] ?? null; }
  getItem(key) { return this._data.has(key) ? this._data.get(key) : null; }
  setItem(key, value) {
    if (this.failEnvelopeWrites && key === 'vault') throw new Error('simulated storage failure');
    this._data.set(key, String(value));
  }
  removeItem(key) { this._data.delete(key); }
}

const PASS_A = 'correct horse battery staple';
const PASS_B = 'different violet whale passphrase';
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log('✅ ' + name);
    passed++;
  } catch (err) {
    console.error('❌ ' + name);
    console.error(err && err.stack ? err.stack : err);
    failed++;
  }
}

function manager(storage, cryptoApi = webcrypto) {
  return createManager({
    storage,
    crypto: cryptoApi,
    envelopeKey: 'vault',
    iterations: 600000,
    sensitiveKeys: ['db', 'url', 'prices'],
    sensitivePrefixes: ['RECOVERY_']
  });
}

function gatedCrypto(method) {
  let release, reached, armed = false;
  const waiting = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const cryptoApi = {
    getRandomValues: value => webcrypto.getRandomValues(value),
    subtle: new Proxy(webcrypto.subtle, {
      get(target, name) {
        if (typeof target[name] !== 'function') return target[name];
        return async (...args) => {
          if (armed && name === method) { armed = false; reached(); await waiting; }
          return target[name](...args);
        };
      }
    })
  };
  return { cryptoApi, arm() { armed = true; }, entered, release() { release(); } };
}

(async () => {
  await test('disabled vault delegates protected and harmless keys to native storage', async () => {
    const storage = new FakeStorage();
    const vault = manager(storage);
    vault.storage.setItem('db', '{"rows":1}');
    vault.storage.setItem('theme', 'dark');
    assert.strictEqual(vault.storage.getItem('db'), '{"rows":1}');
    assert.strictEqual(storage.getItem('db'), '{"rows":1}');
    assert.strictEqual(storage.getItem('theme'), 'dark');
  });

  await test('passphrase bounds reject short and excessive input before migration', async () => {
    const storage = new FakeStorage({ db: 'only-copy' });
    const vault = manager(storage);
    await assert.rejects(vault.enable('too short'), err => err && err.code === 'weak-passphrase');
    await assert.rejects(vault.enable('x'.repeat(257)), err => err && err.code === 'weak-passphrase');
    assert.strictEqual(storage.getItem('db'), 'only-copy');
    assert.strictEqual(storage.getItem('vault'), null);
  });

  await test('imported envelopes cap PBKDF2 work to prevent a hostile CPU lockup', async () => {
    const storage = new FakeStorage({ db: 'secret' });
    const vault = manager(storage);
    await vault.enable(PASS_A);
    const envelope = JSON.parse(storage.getItem('vault'));
    envelope.kdf.iterations = 2000001;
    assert.throws(() => parseEnvelope(JSON.stringify(envelope)), err => err && err.code === 'invalid-envelope');
  });

  await test('enable verifies ciphertext before removing every sensitive plaintext value', async () => {
    const storage = new FakeStorage({
      db: '{"stocks":["MU"]}',
      url: 'https://script.google.com/example',
      prices: '{"MU":123}',
      RECOVERY_1: '{"stocks":[]}',
      theme: 'light'
    });
    const vault = manager(storage);
    await vault.enable(PASS_A);
    assert.strictEqual(vault.isEnabled(), true);
    assert.strictEqual(vault.isUnlocked(), true);
    assert.strictEqual(storage.getItem('db'), null);
    assert.strictEqual(storage.getItem('url'), null);
    assert.strictEqual(storage.getItem('prices'), null);
    assert.strictEqual(storage.getItem('RECOVERY_1'), null);
    assert.strictEqual(storage.getItem('theme'), 'light');
    assert.strictEqual(vault.storage.getItem('db'), '{"stocks":["MU"]}');
    assert.doesNotThrow(() => parseEnvelope(storage.getItem('vault')));
  });

  await test('encrypted mutations stay synchronous in memory and persist in order', async () => {
    const storage = new FakeStorage({ db: 'one' });
    const vault = manager(storage);
    await vault.enable(PASS_A);
    vault.storage.setItem('db', 'two');
    vault.storage.setItem('db', 'three');
    vault.storage.setItem('RECOVERY_2', 'snapshot');
    assert.strictEqual(vault.storage.getItem('db'), 'three');
    assert.strictEqual(vault.hasPendingWrite(), true);
    await vault.flush();
    assert.strictEqual(vault.hasPendingWrite(), false);
    vault.lock();
    assert.throws(() => vault.storage.getItem('db'), err => err && err.code === 'locked');
    await vault.unlock(PASS_A);
    assert.strictEqual(vault.storage.getItem('db'), 'three');
    assert.strictEqual(vault.storage.getItem('RECOVERY_2'), 'snapshot');
    assert.strictEqual(storage.getItem('db'), null);
  });

  await test('wrong passphrase fails closed without changing the encrypted bytes', async () => {
    const storage = new FakeStorage({ db: 'secret' });
    const vault = manager(storage);
    await vault.enable(PASS_A);
    const before = storage.getItem('vault');
    vault.lock();
    await assert.rejects(vault.unlock('wrong passphrase value'), err => err && err.code === 'unlock-failed');
    assert.strictEqual(storage.getItem('vault'), before);
    assert.strictEqual(storage.getItem('db'), null);
  });

  await test('passphrase change is atomic and invalidates the old passphrase', async () => {
    const storage = new FakeStorage({ db: 'secret' });
    const vault = manager(storage);
    await vault.enable(PASS_A);
    await vault.changePassphrase(PASS_B);
    vault.lock();
    await assert.rejects(vault.unlock(PASS_A), err => err && err.code === 'unlock-failed');
    await vault.unlock(PASS_B);
    assert.strictEqual(vault.storage.getItem('db'), 'secret');
  });

  await test('another unlocked tab can decrypt and adopt a same-passphrase envelope', async () => {
    const storage = new FakeStorage({ db: 'one' });
    const first = manager(storage);
    await first.enable(PASS_A);
    const second = manager(storage);
    await second.unlock(PASS_A);
    first.storage.setItem('db', 'two');
    await first.flush();
    const entries = await second.applyExternalEnvelope(storage.getItem('vault'));
    assert.strictEqual(entries.db, 'two');
    assert.strictEqual(second.storage.getItem('db'), 'two');
  });

  await test('disable verifies plaintext before removing the encrypted vault', async () => {
    const storage = new FakeStorage({ db: 'secret', theme: 'dark' });
    const vault = manager(storage);
    await vault.enable(PASS_A);
    await vault.disable();
    assert.strictEqual(vault.isEnabled(), false);
    assert.strictEqual(storage.getItem('vault'), null);
    assert.strictEqual(storage.getItem('db'), 'secret');
    assert.strictEqual(storage.getItem('theme'), 'dark');
  });

  await test('failed encrypted migration leaves plaintext intact and encryption off', async () => {
    const storage = new FakeStorage({ db: 'only-copy' });
    storage.failEnvelopeWrites = true;
    const vault = manager(storage);
    await assert.rejects(vault.enable(PASS_A), /simulated storage failure/);
    assert.strictEqual(storage.getItem('db'), 'only-copy');
    assert.strictEqual(storage.getItem('vault'), null);
    assert.strictEqual(vault.isEnabled(), false);
  });

  await test('encrypted envelope export and restore preserve the locked recovery path', async () => {
    const storage = new FakeStorage({ db: 'recover-me' });
    const vault = manager(storage);
    await vault.enable(PASS_A);
    const exported = vault.exportEnvelope();
    vault.resetEncryptedData();
    assert.strictEqual(vault.isEnabled(), false);
    vault.replaceEnvelope(exported);
    assert.strictEqual(vault.isEnabled(), true);
    assert.strictEqual(vault.isUnlocked(), false);
    await vault.unlock(PASS_A);
    assert.strictEqual(vault.storage.getItem('db'), 'recover-me');
  });

  await test('enable rejects concurrent writes visibly and preserves an acknowledged retry after reload', async () => {
    const storage = new FakeStorage({ db: 'before-enable' });
    const gate = gatedCrypto('deriveKey'), vault = manager(storage, gate.cryptoApi);
    gate.arm(); const enabling = vault.enable(PASS_A);
    assert.strictEqual(vault.isBusy(), true);
    assert.strictEqual(vault.hasPendingWrite(), true);
    await gate.entered;
    assert.throws(() => vault.storage.setItem('db', 'during-enable'), err => err.code === 'busy');
    assert.throws(() => vault.storage.removeItem('db'), err => err.code === 'busy');
    assert.throws(() => vault.lock(), err => err.code === 'busy');
    await assert.rejects(vault.enable(PASS_B), err => err.code === 'busy');
    let flushed = false;
    const flushing = vault.flush().then(() => { flushed = true; });
    await Promise.resolve(); assert.strictEqual(flushed, false);
    gate.release(); await enabling; await flushing;
    vault.storage.setItem('db', 'acknowledged-retry'); await vault.flush();
    const reopened = manager(storage); await reopened.unlock(PASS_A);
    assert.strictEqual(reopened.storage.getItem('db'), 'acknowledged-retry');
    assert.strictEqual(storage.getItem('db'), null);
    assert.strictEqual(vault.isBusy(), false);
  });

  await test('passphrase changes drain accepted writes and reject changes during derivation', async () => {
    const storage = new FakeStorage({ db: 'before' });
    const gate = gatedCrypto('deriveKey'), vault = manager(storage, gate.cryptoApi);
    await vault.enable(PASS_A);
    vault.storage.setItem('db', 'accepted-before-change');
    gate.arm(); const changing = vault.changePassphrase(PASS_B); await gate.entered;
    assert.throws(() => vault.storage.setItem('db', 'during-change'), err => err.code === 'busy');
    gate.release(); await changing;
    const reopened = manager(storage); await reopened.unlock(PASS_B);
    assert.strictEqual(reopened.storage.getItem('db'), 'accepted-before-change');
    reopened.lock(); await assert.rejects(reopened.unlock(PASS_A), err => err.code === 'unlock-failed');
  });

  await test('enable preserves an accepted write from another plaintext tab during encryption', async () => {
    const storage = new FakeStorage({ db: 'before' });
    const gate = gatedCrypto('encrypt'), vault = manager(storage, gate.cryptoApi), otherTab = manager(storage);
    gate.arm(); const enabling = vault.enable(PASS_A); await gate.entered;
    otherTab.storage.setItem('db', 'accepted-in-other-tab');
    gate.release(); await assert.rejects(enabling, err => err.code === 'concurrent-change');
    assert.strictEqual(storage.getItem('db'), 'accepted-in-other-tab');
    assert.strictEqual(storage.getItem('vault'), null);
    assert.strictEqual(vault.isBusy(), false);
  });

  await test('passphrase derivation preserves another tab\'s accepted encrypted update', async () => {
    const storage = new FakeStorage({ db: 'before' });
    const gate = gatedCrypto('deriveKey'), vault = manager(storage, gate.cryptoApi);
    await vault.enable(PASS_A);
    const otherTab = manager(storage); await otherTab.unlock(PASS_A);
    gate.arm(); const changing = vault.changePassphrase(PASS_B); await gate.entered;
    otherTab.storage.setItem('db', 'accepted-in-other-tab'); await otherTab.flush();
    const external = storage.getItem('vault');
    gate.release(); await assert.rejects(changing, err => err.code === 'concurrent-change');
    assert.strictEqual(storage.getItem('vault'), external);
    const reopened = manager(storage); await reopened.unlock(PASS_A);
    assert.strictEqual(reopened.storage.getItem('db'), 'accepted-in-other-tab');
    assert.strictEqual(vault.isBusy(), false);
  });

  await test('passphrase verification failure never rolls back over a third-party envelope', async () => {
    const storage = new FakeStorage({ db: 'before' });
    const gate = gatedCrypto('decrypt'), vault = manager(storage, gate.cryptoApi);
    await vault.enable(PASS_A);
    const otherTab = manager(storage); await otherTab.unlock(PASS_A);
    gate.arm(); const changing = vault.changePassphrase(PASS_B); await gate.entered;
    otherTab.storage.setItem('db', 'accepted-during-verification'); await otherTab.flush();
    const external = storage.getItem('vault');
    gate.release(); await assert.rejects(changing, err => err.code === 'concurrent-change');
    assert.strictEqual(storage.getItem('vault'), external);
    const reopened = manager(storage); await reopened.unlock(PASS_A);
    assert.strictEqual(reopened.storage.getItem('db'), 'accepted-during-verification');
    assert.strictEqual(vault.isBusy(), false);
  });

  await test('enable retains encrypted recovery if plaintext cleanup and rollback both fail', async () => {
    const storage = new FakeStorage({ db: 'synthetic-db', prices: 'synthetic-prices' });
    const vault = manager(storage), remove = storage.removeItem.bind(storage), set = storage.setItem.bind(storage);
    storage.removeItem = name => { if (name === 'prices') throw new Error('cleanup failure'); remove(name); };
    storage.setItem = (name, value) => { if (name === 'db') throw new Error('rollback quota failure'); set(name, value); };
    await assert.rejects(vault.enable(PASS_A), err => err.code === 'cleanup-failed');
    assert.strictEqual(vault.isEnabled(), true); assert.strictEqual(vault.isUnlocked(), true);
    assert.strictEqual(vault.storage.getItem('db'), 'synthetic-db');
    storage.removeItem = remove;
    const reopened = manager(storage); await reopened.unlock(PASS_A);
    assert.strictEqual(reopened.storage.getItem('db'), 'synthetic-db');
    assert.strictEqual(reopened.storage.getItem('prices'), 'synthetic-prices');
  });

  await test('disable drains accepted writes while blocking new writes and lifecycle operations', async () => {
    const storage = new FakeStorage({ db: 'before' });
    const gate = gatedCrypto('encrypt'), vault = manager(storage, gate.cryptoApi);
    await vault.enable(PASS_A);
    gate.arm(); vault.storage.setItem('db', 'accepted-before-disable'); await gate.entered;
    const disabling = vault.disable();
    assert.throws(() => vault.storage.setItem('db', 'during-disable'), err => err.code === 'busy');
    assert.throws(() => vault.resetEncryptedData(), err => err.code === 'busy');
    gate.release(); await disabling;
    assert.strictEqual(storage.getItem('db'), 'accepted-before-disable');
    assert.strictEqual(vault.isEnabled(), false);
  });

  await test('failed disable rolls back each partial plaintext write and retains encrypted recovery', async () => {
    for (const failAt of [1, 2, 3]) {
      const storage = new FakeStorage({ db: 'synthetic-db', prices: 'synthetic-prices', url: 'synthetic-url' });
      const vault = manager(storage); await vault.enable(PASS_A);
      const encrypted = storage.getItem('vault'), set = storage.setItem.bind(storage); let writes = 0;
      storage.setItem = (name, value) => {
        if (name !== 'vault' && ++writes === failAt) throw new Error('synthetic quota failure');
        return set(name, value);
      };
      await assert.rejects(vault.disable(), /synthetic quota failure/);
      assert.strictEqual(vault.isEnabled(), true); assert.strictEqual(vault.isBusy(), false);
      assert.strictEqual(storage.getItem('vault'), encrypted);
      for (const name of ['db', 'prices', 'url']) assert.strictEqual(storage.getItem(name), null);
      const reopened = manager(storage); await reopened.unlock(PASS_A);
      assert.strictEqual(reopened.storage.getItem('db'), 'synthetic-db');
    }
  });

  await test('failed disable reports remaining plaintext when rollback removal is refused', async () => {
    const storage = new FakeStorage({ db: 'synthetic-db', prices: 'synthetic-prices' });
    const vault = manager(storage); await vault.enable(PASS_A);
    const set = storage.setItem.bind(storage), remove = storage.removeItem.bind(storage);
    storage.setItem = (name, value) => { if (name === 'prices') throw new Error('quota failure'); set(name, value); };
    storage.removeItem = name => { if (name !== 'db') remove(name); };
    await assert.rejects(vault.disable(), err => err.code === 'cleanup-failed' && /plaintext may remain/.test(err.message));
    assert.strictEqual(vault.isEnabled(), true);
    assert.strictEqual(storage.getItem('db'), 'synthetic-db');
    assert.strictEqual(vault.storage.getItem('prices'), 'synthetic-prices');
  });

  await test('failed envelope removal rolls plaintext back and leaves the encrypted vault usable', async () => {
    const storage = new FakeStorage({ db: 'synthetic-db' }), vault = manager(storage);
    await vault.enable(PASS_A);
    const remove = storage.removeItem.bind(storage); storage.removeItem = name => { if (name !== 'vault') remove(name); };
    await assert.rejects(vault.disable(), err => err.code === 'cleanup-failed');
    assert.strictEqual(storage.getItem('db'), null);
    assert.strictEqual(vault.storage.getItem('db'), 'synthetic-db');
    assert.strictEqual(vault.isBusy(), false);
  });

  await test('disable retains plaintext if envelope removal applied but encrypted rollback also fails', async () => {
    const storage = new FakeStorage({ db: 'synthetic-db', prices: 'synthetic-prices' }), vault = manager(storage);
    await vault.enable(PASS_A);
    const remove = storage.removeItem.bind(storage);
    storage.removeItem = name => { remove(name); if (name === 'vault') throw new Error('removal interrupted'); };
    storage.failEnvelopeWrites = true;
    await assert.rejects(vault.disable(), err => err.code === 'cleanup-failed');
    assert.strictEqual(storage.getItem('db'), 'synthetic-db');
    assert.strictEqual(storage.getItem('prices'), 'synthetic-prices');
    assert.strictEqual(vault.isBusy(), false);
  });

  await test('repeated unlock drains an accepted encrypted write before reading its snapshot', async () => {
    const storage = new FakeStorage({ db: 'before' });
    const gate = gatedCrypto('encrypt'), vault = manager(storage, gate.cryptoApi);
    await vault.enable(PASS_A);
    gate.arm(); vault.storage.setItem('db', 'accepted'); await gate.entered;
    const unlocking = vault.unlock(PASS_A);
    assert.throws(() => vault.lock(), err => err.code === 'busy');
    gate.release(); await unlocking;
    assert.strictEqual(vault.storage.getItem('db'), 'accepted');
  });

  await test('stale external envelopes cannot replace a newly acknowledged local write', async () => {
    const storage = new FakeStorage({ db: 'before' }), vault = manager(storage);
    await vault.enable(PASS_A);
    const stale = storage.getItem('vault');
    vault.storage.setItem('db', 'accepted-new-local');
    await assert.rejects(vault.applyExternalEnvelope(stale), err => err.code === 'concurrent-change');
    assert.strictEqual(vault.storage.getItem('db'), 'accepted-new-local');
    const reopened = manager(storage); await reopened.unlock(PASS_A);
    assert.strictEqual(reopened.storage.getItem('db'), 'accepted-new-local');
  });

  await test('browser boot loads the vault module before app code and unlocks before reading local data', async () => {
    const vaultScriptAt = indexSource.indexOf('Worker/kjr-vault.js?v=');
    const appScriptAt = indexSource.indexOf('Worker/app.js?v=');
    assert.ok(vaultScriptAt >= 0 && appScriptAt > vaultScriptAt);
    const bootAt = appSource.indexOf('async function boot()');
    const unlockAt = appSource.indexOf('await showVaultUnlockGate()', bootAt);
    const loadAt = appSource.indexOf('const had = loadLocal()', bootAt);
    assert.ok(bootAt >= 0 && unlockAt > bootAt && loadAt > unlockAt);
  });

  await test('every sensitive app write uses protectedStorage instead of native localStorage', async () => {
    const direct = appSource.match(/localStorage\.(?:getItem|setItem|removeItem)\((?:LK_DB|LK_SYNC_URL|LK_PRICE_CACHE)/g) || [];
    assert.deepStrictEqual(direct, []);
    ['enableVaultProtection', 'changeVaultPassphrase', 'lockVaultNow', 'disableVaultProtection'].forEach(action => {
      assert.ok(indexSource.includes(`data-click="${action}"`), 'missing control for ' + action);
    });
  });

  await test('destructive encrypted reset and restore download the current envelope first', async () => {
    const resetStart = appSource.indexOf('function _resetEncryptedBrowserData()');
    const resetEnd = appSource.indexOf('function showVaultUnlockGate()', resetStart);
    const resetSource = appSource.slice(resetStart, resetEnd);
    assert.ok(resetSource.indexOf('_downloadVaultEnvelope()') >= 0);
    assert.ok(resetSource.indexOf('_downloadVaultEnvelope()') < resetSource.indexOf('_vaultManager.resetEncryptedData()'));

    const importStart = appSource.indexOf('function _importVaultEnvelope(input)');
    const importEnd = appSource.indexOf('function _resetEncryptedBrowserData()', importStart);
    const importSource = appSource.slice(importStart, importEnd);
    assert.ok(importSource.indexOf('_downloadVaultEnvelope()') >= 0);
    assert.ok(importSource.indexOf('_downloadVaultEnvelope()') < importSource.indexOf('_vaultManager.replaceEnvelope(raw)'));
  });

  console.log(`\nVault tests: ${passed} passed, ${failed} failed.`);
  if (failed) process.exit(1);
})();
