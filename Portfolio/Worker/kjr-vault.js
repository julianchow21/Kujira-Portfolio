/* Kujira encrypted browser vault.
   Optional, passphrase-derived protection for sensitive localStorage values.
   The passphrase and derived key exist only in memory for the unlocked tab.
   Browser: window.KjrVault. Node tests: require('./kjr-vault.js'). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KjrVault = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FORMAT = 'kujira-encrypted-vault';
  const VERSION = 1;
  const MIN_ITERATIONS = 600000;
  const DEFAULT_ITERATIONS = 600000;
  const MAX_ITERATIONS = 2000000;
  const MAX_PASSPHRASE_LENGTH = 256;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  class VaultError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'VaultError';
      this.code = code;
    }
  }

  function bytesToBase64(bytes) {
    if (typeof btoa === 'function') {
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    throw new VaultError('base64-unavailable', 'Base64 encoding is unavailable in this browser.');
  }

  function base64ToBytes(value) {
    try {
      if (typeof atob === 'function') {
        const binary = atob(value);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
      }
      if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
    } catch (_) {
      throw new VaultError('invalid-envelope', 'The encrypted vault contains invalid base64 data.');
    }
    throw new VaultError('base64-unavailable', 'Base64 decoding is unavailable in this browser.');
  }

  function cloneEntries(entries) {
    const out = {};
    Object.keys(entries || {}).sort().forEach(key => {
      if (typeof entries[key] === 'string') out[key] = entries[key];
    });
    return out;
  }

  function sameEntries(a, b) {
    return JSON.stringify(cloneEntries(a)) === JSON.stringify(cloneEntries(b));
  }

  function parseEnvelope(raw) {
    let envelope;
    try { envelope = JSON.parse(raw); }
    catch (_) { throw new VaultError('invalid-envelope', 'The encrypted vault is not valid JSON.'); }
    const valid = envelope && envelope.format === FORMAT && envelope.version === VERSION &&
      envelope.kdf && envelope.kdf.name === 'PBKDF2' && envelope.kdf.hash === 'SHA-256' &&
      Number.isInteger(envelope.kdf.iterations) && envelope.kdf.iterations >= MIN_ITERATIONS && envelope.kdf.iterations <= MAX_ITERATIONS &&
      typeof envelope.kdf.salt === 'string' && envelope.cipher &&
      envelope.cipher.name === 'AES-GCM' && typeof envelope.cipher.iv === 'string' &&
      typeof envelope.ciphertext === 'string';
    if (!valid) throw new VaultError('invalid-envelope', 'The encrypted vault format is not supported.');
    const salt = base64ToBytes(envelope.kdf.salt);
    const iv = base64ToBytes(envelope.cipher.iv);
    if (salt.length !== 16 || iv.length !== 12) {
      throw new VaultError('invalid-envelope', 'The encrypted vault parameters are invalid.');
    }
    return { envelope, salt, iv };
  }

  async function deriveKey(cryptoApi, passphrase, salt, iterations) {
    if (!cryptoApi || !cryptoApi.subtle || !cryptoApi.getRandomValues) {
      throw new VaultError('crypto-unavailable', 'This browser does not support Web Crypto.');
    }
    const material = await cryptoApi.subtle.importKey(
      'raw', encoder.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return cryptoApi.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptEntries(cryptoApi, key, salt, iterations, entries) {
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const payload = encoder.encode(JSON.stringify({
      format: FORMAT,
      version: VERSION,
      entries: cloneEntries(entries)
    }));
    const ciphertext = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);
    return JSON.stringify({
      format: FORMAT,
      version: VERSION,
      kdf: {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations,
        salt: bytesToBase64(salt)
      },
      cipher: { name: 'AES-GCM', iv: bytesToBase64(iv) },
      ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    });
  }

  async function decryptEntries(cryptoApi, key, raw) {
    const parsed = parseEnvelope(raw);
    let plaintext;
    try {
      plaintext = await cryptoApi.subtle.decrypt(
        { name: 'AES-GCM', iv: parsed.iv },
        key,
        base64ToBytes(parsed.envelope.ciphertext)
      );
    } catch (_) {
      throw new VaultError('unlock-failed', 'The passphrase is incorrect or the encrypted vault is damaged.');
    }
    let payload;
    try { payload = JSON.parse(decoder.decode(plaintext)); }
    catch (_) { throw new VaultError('invalid-payload', 'The decrypted vault payload is invalid.'); }
    if (!payload || payload.format !== FORMAT || payload.version !== VERSION ||
        !payload.entries || typeof payload.entries !== 'object' || Array.isArray(payload.entries)) {
      throw new VaultError('invalid-payload', 'The decrypted vault payload is not supported.');
    }
    return cloneEntries(payload.entries);
  }

  function listStorageKeys(storage) {
    const keys = [];
    if (typeof storage.length === 'number' && typeof storage.key === 'function') {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (typeof key === 'string') keys.push(key);
      }
      return keys;
    }
    if (storage._data && typeof storage._data.keys === 'function') {
      return Array.from(storage._data.keys());
    }
    return keys;
  }

  function createManager(options) {
    options = options || {};
    const storage = options.storage;
    const cryptoApi = options.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    const envelopeKey = options.envelopeKey || 'kjr-vault-v1';
    const iterations = options.iterations || DEFAULT_ITERATIONS;
    const exactKeys = new Set(options.sensitiveKeys || []);
    const prefixes = (options.sensitivePrefixes || []).slice();
    const onError = typeof options.onError === 'function' ? options.onError : function () {};

    if (!storage) throw new VaultError('storage-unavailable', 'Browser storage is unavailable.');
    if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
      throw new VaultError('invalid-iterations', 'PBKDF2 iterations are outside the supported security range.');
    }

    let key = null;
    let salt = null;
    let activeIterations = iterations;
    let entries = {};
    let unlocked = false;
    let dirty = false;
    let persistPromise = null;
    let lastError = null;

    function isSensitiveKey(name) {
      return exactKeys.has(name) || prefixes.some(prefix => name.startsWith(prefix));
    }

    function isEnabled() { return storage.getItem(envelopeKey) != null; }
    function isUnlocked() { return isEnabled() && unlocked && !!key; }
    function hasPendingWrite() { return dirty || !!persistPromise; }
    function getLastError() { return lastError; }

    function collectPlaintextEntries() {
      const out = {};
      listStorageKeys(storage).forEach(name => {
        if (!isSensitiveKey(name)) return;
        const value = storage.getItem(name);
        if (value != null) out[name] = value;
      });
      exactKeys.forEach(name => {
        const value = storage.getItem(name);
        if (value != null) out[name] = value;
      });
      return out;
    }

    function removePlaintextEntries() {
      listStorageKeys(storage).forEach(name => {
        if (isSensitiveKey(name)) storage.removeItem(name);
      });
      exactKeys.forEach(name => storage.removeItem(name));
    }

    async function persistSnapshot(snapshot) {
      const raw = await encryptEntries(cryptoApi, key, salt, activeIterations, snapshot);
      storage.setItem(envelopeKey, raw);
      const verify = await decryptEntries(cryptoApi, key, storage.getItem(envelopeKey));
      if (!sameEntries(snapshot, verify)) {
        throw new VaultError('verification-failed', 'The encrypted vault did not verify after saving.');
      }
    }

    function schedulePersist() {
      if (!isUnlocked()) throw new VaultError('locked', 'Unlock the encrypted vault before changing protected data.');
      dirty = true;
      if (persistPromise) return persistPromise;
      persistPromise = (async function drain() {
        while (dirty) {
          dirty = false;
          const snapshot = cloneEntries(entries);
          try {
            await persistSnapshot(snapshot);
            lastError = null;
          } catch (err) {
            lastError = err;
            onError(err);
            throw err;
          }
        }
      })().finally(() => { persistPromise = null; });
      return persistPromise;
    }

    async function flush() {
      if (dirty && !persistPromise) schedulePersist();
      if (persistPromise) await persistPromise;
      if (lastError) throw lastError;
      return true;
    }

    async function enable(passphrase) {
      if (isEnabled()) throw new VaultError('already-enabled', 'Device encryption is already enabled.');
      if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > MAX_PASSPHRASE_LENGTH) {
        throw new VaultError('weak-passphrase', 'Use a passphrase between 12 and 256 characters.');
      }
      const plaintext = collectPlaintextEntries();
      const nextSalt = cryptoApi.getRandomValues(new Uint8Array(16));
      const nextKey = await deriveKey(cryptoApi, passphrase, nextSalt, iterations);
      const previousEnvelope = storage.getItem(envelopeKey);
      const raw = await encryptEntries(cryptoApi, nextKey, nextSalt, iterations, plaintext);
      try {
        storage.setItem(envelopeKey, raw);
        const verified = await decryptEntries(cryptoApi, nextKey, storage.getItem(envelopeKey));
        if (!sameEntries(plaintext, verified)) {
          throw new VaultError('verification-failed', 'The encrypted migration copy did not verify.');
        }
        removePlaintextEntries();
        const leaked = collectPlaintextEntries();
        if (Object.keys(leaked).length) {
          throw new VaultError('cleanup-failed', 'Plaintext data could not be removed after encryption.');
        }
      } catch (err) {
        if (previousEnvelope == null) storage.removeItem(envelopeKey);
        else storage.setItem(envelopeKey, previousEnvelope);
        Object.keys(plaintext).forEach(name => storage.setItem(name, plaintext[name]));
        throw err;
      }
      key = nextKey;
      salt = nextSalt;
      activeIterations = iterations;
      entries = cloneEntries(plaintext);
      unlocked = true;
      lastError = null;
      return true;
    }

    async function unlock(passphrase) {
      const raw = storage.getItem(envelopeKey);
      if (!raw) return false;
      const parsed = parseEnvelope(raw);
      const nextKey = await deriveKey(cryptoApi, passphrase, parsed.salt, parsed.envelope.kdf.iterations);
      const decrypted = await decryptEntries(cryptoApi, nextKey, raw);
      key = nextKey;
      salt = parsed.salt;
      activeIterations = parsed.envelope.kdf.iterations;
      entries = decrypted;
      unlocked = true;
      lastError = null;
      removePlaintextEntries();
      return true;
    }

    async function disable() {
      if (!isUnlocked()) throw new VaultError('locked', 'Unlock the encrypted vault before disabling encryption.');
      await flush();
      const snapshot = cloneEntries(entries);
      Object.keys(snapshot).forEach(name => storage.setItem(name, snapshot[name]));
      for (const name of Object.keys(snapshot)) {
        if (storage.getItem(name) !== snapshot[name]) {
          throw new VaultError('verification-failed', 'Plaintext data did not verify while disabling encryption.');
        }
      }
      storage.removeItem(envelopeKey);
      if (storage.getItem(envelopeKey) != null) {
        throw new VaultError('cleanup-failed', 'The encrypted vault could not be removed.');
      }
      lock();
      return true;
    }

    async function changePassphrase(nextPassphrase) {
      if (!isUnlocked()) throw new VaultError('locked', 'Unlock the encrypted vault before changing its passphrase.');
      if (typeof nextPassphrase !== 'string' || nextPassphrase.length < 12 || nextPassphrase.length > MAX_PASSPHRASE_LENGTH) {
        throw new VaultError('weak-passphrase', 'Use a passphrase between 12 and 256 characters.');
      }
      await flush();
      const oldRaw = storage.getItem(envelopeKey);
      const nextSalt = cryptoApi.getRandomValues(new Uint8Array(16));
      const nextKey = await deriveKey(cryptoApi, nextPassphrase, nextSalt, iterations);
      const snapshot = cloneEntries(entries);
      try {
        const nextRaw = await encryptEntries(cryptoApi, nextKey, nextSalt, iterations, snapshot);
        storage.setItem(envelopeKey, nextRaw);
        const verified = await decryptEntries(cryptoApi, nextKey, storage.getItem(envelopeKey));
        if (!sameEntries(snapshot, verified)) {
          throw new VaultError('verification-failed', 'The new encrypted vault did not verify.');
        }
      } catch (err) {
        storage.setItem(envelopeKey, oldRaw);
        throw err;
      }
      key = nextKey;
      salt = nextSalt;
      activeIterations = iterations;
      lastError = null;
      return true;
    }

    function lock() {
      key = null;
      salt = null;
      entries = {};
      unlocked = false;
      dirty = false;
      persistPromise = null;
      lastError = null;
    }

    async function applyExternalEnvelope(raw) {
      if (!isUnlocked()) throw new VaultError('locked', 'Unlock the encrypted vault before applying another tab\'s update.');
      await flush();
      const parsed = parseEnvelope(raw);
      if (bytesToBase64(parsed.salt) !== bytesToBase64(salt) ||
          parsed.envelope.kdf.iterations !== activeIterations) {
        throw new VaultError('reunlock-required', 'The vault passphrase changed in another tab. Reload and unlock again.');
      }
      entries = await decryptEntries(cryptoApi, key, raw);
      return cloneEntries(entries);
    }

    function exportEnvelope() {
      const raw = storage.getItem(envelopeKey);
      if (!raw) throw new VaultError('not-enabled', 'Device encryption is not enabled.');
      parseEnvelope(raw);
      return raw;
    }

    function replaceEnvelope(raw) {
      parseEnvelope(raw);
      storage.setItem(envelopeKey, raw);
      if (storage.getItem(envelopeKey) !== raw) {
        throw new VaultError('verification-failed', 'The imported encrypted vault did not verify in browser storage.');
      }
      removePlaintextEntries();
      lock();
      return true;
    }

    function resetEncryptedData() {
      storage.removeItem(envelopeKey);
      removePlaintextEntries();
      lock();
    }

    const facade = {
      getItem(name) {
        if (!isSensitiveKey(name)) return storage.getItem(name);
        if (!isEnabled()) return storage.getItem(name);
        if (!isUnlocked()) throw new VaultError('locked', 'Protected browser data is locked.');
        return Object.prototype.hasOwnProperty.call(entries, name) ? entries[name] : null;
      },
      setItem(name, value) {
        if (!isSensitiveKey(name)) { storage.setItem(name, value); return; }
        if (!isEnabled()) { storage.setItem(name, value); return; }
        if (!isUnlocked()) throw new VaultError('locked', 'Protected browser data is locked.');
        entries[name] = String(value);
        schedulePersist().catch(function () {});
      },
      removeItem(name) {
        if (!isSensitiveKey(name)) { storage.removeItem(name); return; }
        if (!isEnabled()) { storage.removeItem(name); return; }
        if (!isUnlocked()) throw new VaultError('locked', 'Protected browser data is locked.');
        delete entries[name];
        schedulePersist().catch(function () {});
      }
    };

    return {
      storage: facade,
      envelopeKey,
      isSensitiveKey,
      isEnabled,
      isUnlocked,
      hasPendingWrite,
      getLastError,
      enable,
      unlock,
      disable,
      changePassphrase,
      flush,
      lock,
      applyExternalEnvelope,
      exportEnvelope,
      replaceEnvelope,
      resetEncryptedData
    };
  }

  return {
    FORMAT,
    VERSION,
    MIN_ITERATIONS,
    DEFAULT_ITERATIONS,
    MAX_ITERATIONS,
    MAX_PASSPHRASE_LENGTH,
    VaultError,
    parseEnvelope,
    createManager
  };
});
