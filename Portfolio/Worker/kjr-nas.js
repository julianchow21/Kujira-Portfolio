/*
 * Kujira Portfolio NAS controller.
 *
 * This module owns no browser state.  A caller supplies the already-created
 * Supabase client and an encrypted storage facade.  The same file is usable
 * as a plain browser script and as a CommonJS module for tests.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KjrNas = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  var PREFIX = 'kjr-pf-nas-v1:';
  var PAGE_SIZE = 200;
  var MAX_RECORDS = 10000;
  var MAX_QUEUE = 10000;
  var MAX_RECOVERY = 5;
  var MAX_PAYLOAD_BYTES = 12 * 1024 * 1024;
  var MAX_USER_ID = 128;
  var MAX_RECORD_ID = 64;
  var MAX_FRIENDLY_NAME = 128;
  var MAX_TOTP_CODE = 8;
  var MAX_SAFE_INTEGER = 9007199254740991;

  var ARRAY_TYPES = [
    'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate', 'cash',
    'cashTxns', 'cpfHistory', 'income', 'expenses', 'snapshots', 'trash',
    'insurance', 'insuranceRiders'
  ];
  var SINGLETON_TYPES = ['cpfBalances', 'categories', 'settings', '_meta'];
  var META_KEYS = [
    'schema', 'version', 'schemaVersion', 'appVersion', 'updatedAt',
    'lastSeenRemoteAt', '_savedAt'
  ];
  var SUPPORTED = Object.create(null);
  var ARRAY_LOOKUP = Object.create(null);
  var SINGLETON_LOOKUP = Object.create(null);
  var META_LOOKUP = Object.create(null);
  var HAS_OWN = Object.prototype.hasOwnProperty;
  var DANGEROUS = Object.create(null);
  DANGEROUS.__proto__ = true;
  DANGEROUS.prototype = true;
  DANGEROUS.constructor = true;

  ARRAY_TYPES.forEach(function (name) {
    SUPPORTED[name] = true;
    ARRAY_LOOKUP[name] = true;
  });
  SINGLETON_TYPES.forEach(function (name) {
    SUPPORTED[name] = true;
    SINGLETON_LOOKUP[name] = true;
  });
  SUPPORTED._syncMeta = true;
  META_KEYS.forEach(function (name) { META_LOOKUP[name] = true; });

  function hasOwn(value, key) {
    return HAS_OWN.call(value, key);
  }

  function nasError(code) {
    var suffix = String(code || 'FAILED').replace(/^PORTFOLIO_NAS_/, '');
    var error = new Error('PORTFOLIO_NAS_' + suffix);
    error.name = 'PortfolioNasError';
    error.code = 'PORTFOLIO_NAS_' + suffix;
    return error;
  }

  function throwNas(code) {
    throw nasError(code);
  }

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function isPlainObject(value) {
    if (!isObject(value) || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === null || Object.getPrototypeOf(proto) === null;
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && value === value
      && value !== Infinity && value !== -Infinity;
  }

  function checkSymbols(value) {
    if (typeof Object.getOwnPropertySymbols === 'function'
      && Object.getOwnPropertySymbols(value).length) {
      throwNas('MALFORMED_VALUE');
    }
  }

  function checkKey(key) {
    if (DANGEROUS[key]) throwNas('MALFORMED_VALUE');
  }

  function checkDescriptor(value, key, descriptor, allowArrayLength) {
    if (!descriptor || descriptor.get || descriptor.set
      || (!descriptor.enumerable && !allowArrayLength)) {
      throwNas('MALFORMED_VALUE');
    }
    checkKey(key);
  }

  function checkObjectShape(value) {
    if (!isPlainObject(value)) throwNas('MALFORMED_VALUE');
    checkSymbols(value);
    Object.getOwnPropertyNames(value).forEach(function (key) {
      checkDescriptor(value, key, Object.getOwnPropertyDescriptor(value, key), false);
    });
  }

  function checkArrayShape(value) {
    if (!Array.isArray(value)) throwNas('MALFORMED_VALUE');
    checkSymbols(value);
    Object.getOwnPropertyNames(value).forEach(function (key) {
      if (key === 'length') {
        checkDescriptor(value, key, Object.getOwnPropertyDescriptor(value, key), true);
        return;
      }
      checkDescriptor(value, key, Object.getOwnPropertyDescriptor(value, key), false);
      if (!/^\d+$/.test(key)) throwNas('MALFORMED_VALUE');
      var index = Number(key);
      if (String(index) !== key || index < 0 || index >= value.length) {
        throwNas('MALFORMED_VALUE');
      }
    });
    for (var i = 0; i < value.length; i += 1) {
      if (!hasOwn(value, String(i))) throwNas('MALFORMED_VALUE');
    }
  }

  function cloneValue(value, stack) {
    if (value === null) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!isFiniteNumber(value)) throwNas('MALFORMED_VALUE');
      return value;
    }
    if (!isObject(value)) throwNas('MALFORMED_VALUE');
    stack = stack || [];
    if (stack.indexOf(value) !== -1) throwNas('MALFORMED_VALUE');
    stack.push(value);
    var copy;
    if (Array.isArray(value)) {
      checkArrayShape(value);
      copy = [];
      for (var i = 0; i < value.length; i += 1) {
        copy.push(cloneValue(value[i], stack));
      }
    } else {
      checkObjectShape(value);
      copy = {};
      Object.getOwnPropertyNames(value).forEach(function (key) {
        copy[key] = cloneValue(value[key], stack);
      });
    }
    stack.pop();
    return copy;
  }

  function canonicalJson(value, stack) {
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'boolean') {
      return JSON.stringify(value);
    }
    if (typeof value === 'number') {
      if (!isFiniteNumber(value)) throwNas('MALFORMED_VALUE');
      return JSON.stringify(value);
    }
    if (!isObject(value)) throwNas('MALFORMED_VALUE');
    stack = stack || [];
    if (stack.indexOf(value) !== -1) throwNas('MALFORMED_VALUE');
    stack.push(value);
    var output;
    if (Array.isArray(value)) {
      checkArrayShape(value);
      var items = [];
      for (var i = 0; i < value.length; i += 1) {
        items.push(canonicalJson(value[i], stack));
      }
      output = '[' + items.join(',') + ']';
    } else {
      checkObjectShape(value);
      var keys = Object.getOwnPropertyNames(value).sort();
      var pairs = [];
      keys.forEach(function (key) {
        pairs.push(JSON.stringify(key) + ':' + canonicalJson(value[key], stack));
      });
      output = '{' + pairs.join(',') + '}';
    }
    stack.pop();
    return output;
  }

  function utf8ByteLength(value) {
    var bytes = 0;
    for (var i = 0; i < value.length; i += 1) {
      var code = value.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        var next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
        if (next >= 0xDC00 && next <= 0xDFFF) {
          code = 0x10000 + ((code - 0xD800) << 10) + (next - 0xDC00);
          i += 1;
        } else {
          code = 0xFFFD;
        }
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        code = 0xFFFD;
      }
      if (code <= 0x7F) bytes += 1;
      else if (code <= 0x7FF) bytes += 2;
      else if (code <= 0xFFFF) bytes += 3;
      else bytes += 4;
    }
    return bytes;
  }

  function parseInteger(value, minimum) {
    var number;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger || !Number.isSafeInteger(value)) throwNas('MALFORMED_ROW');
      number = value;
    } else if (typeof value === 'string' && /^\d+$/.test(value)) {
      number = Number(value);
      if (!isFiniteNumber(number) || number > MAX_SAFE_INTEGER
        || Math.floor(number) !== number) throwNas('MALFORMED_ROW');
    } else {
      throwNas('MALFORMED_ROW');
    }
    if (number < minimum) throwNas('MALFORMED_ROW');
    return number;
  }

  function isCanonicalUserId(value) {
    return typeof value === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  function isSafeRecordId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  }

  function validateUserId(value) {
    if (!isCanonicalUserId(value) || value.length > MAX_USER_ID) throwNas('UNSAFE_USER');
    return value;
  }

  function validateRecordId(value) {
    if (!isSafeRecordId(value) || value.length > MAX_RECORD_ID) throwNas('MALFORMED_ROW');
    return value;
  }

  function recordKey(recordType, recordId) {
    return recordType + '\u0000' + recordId;
  }

  function copyDateField(row, key) {
    if (!hasOwn(row, key) || row[key] === undefined) return null;
    if (row[key] === null || typeof row[key] !== 'string' || row[key].length === 0) {
      throwNas('MALFORMED_ROW');
    }
    return row[key];
  }

  function validateServerRow(row, userId) {
    if (!isPlainObject(row)) throwNas('MALFORMED_ROW');
    checkObjectShape(row);
    if (row.user_id !== userId) throwNas('WRONG_USER');
    if (typeof row.record_type !== 'string' || !SUPPORTED[row.record_type]) {
      throwNas('MALFORMED_ROW');
    }
    validateRecordId(row.record_id);
    if (!isPlainObject(row.payload)) throwNas('MALFORMED_ROW');
    checkObjectShape(row.payload);
    if (ARRAY_LOOKUP[row.record_type]
      && (!hasOwn(row.payload, 'id') || typeof row.payload.id !== 'string'
        || row.payload.id !== row.record_id)) {
      throwNas('MALFORMED_ROW');
    }
    if (SINGLETON_LOOKUP[row.record_type] || row.record_type === '_syncMeta') {
      if (row.record_id !== 'singleton') throwNas('MALFORMED_ROW');
    }
    var payload = cloneValue(row.payload, []);
    var position = parseInteger(row.position, 0);
    if ((SINGLETON_LOOKUP[row.record_type] || row.record_type === '_syncMeta') && position !== 0) {
      throwNas('MALFORMED_ROW');
    }
    var version = parseInteger(row.version, 1);
    var changeSeq = parseInteger(row.change_seq, 1);
    var deletedAt = hasOwn(row, 'deleted_at') ? row.deleted_at : null;
    if (deletedAt !== null && (typeof deletedAt !== 'string' || deletedAt.length === 0)) {
      throwNas('MALFORMED_ROW');
    }
    return {
      user_id: userId,
      record_type: row.record_type,
      record_id: row.record_id,
      payload: payload,
      position: position,
      version: version,
      change_seq: changeSeq,
      created_at: copyDateField(row, 'created_at'),
      updated_at: copyDateField(row, 'updated_at'),
      deleted_at: deletedAt
    };
  }

  function validateLegacyRecord(record) {
    if (!isPlainObject(record)) throwNas('IMPORT_INVALID');
    checkObjectShape(record);
    if (typeof record.recordType !== 'string' || !SUPPORTED[record.recordType]) {
      throwNas('IMPORT_INVALID');
    }
    validateRecordId(record.recordId);
    if (!isPlainObject(record.payload)) throwNas('IMPORT_INVALID');
    checkObjectShape(record.payload);
    if (ARRAY_LOOKUP[record.recordType]
      && (!hasOwn(record.payload, 'id') || typeof record.payload.id !== 'string'
        || record.payload.id !== record.recordId)) {
      throwNas('IMPORT_INVALID');
    }
    if (SINGLETON_LOOKUP[record.recordType] || record.recordType === '_syncMeta') {
      if (record.recordId !== 'singleton') throwNas('IMPORT_INVALID');
    }
    var payload = cloneValue(record.payload, []);
    var position = parseInteger(record.position, 0);
    if ((SINGLETON_LOOKUP[record.recordType] || record.recordType === '_syncMeta') && position !== 0) {
      throwNas('IMPORT_INVALID');
    }
    return {
      recordType: record.recordType,
      recordId: record.recordId,
      payload: payload,
      position: position
    };
  }

  function validateRecordList(records, maxRecords) {
    if (!Array.isArray(records)) throwNas('MALFORMED_STATE');
    if (records.length > (maxRecords || MAX_RECORDS)) throwNas('RECORD_LIMIT');
    var seen = Object.create(null);
    var payloadBytes = 0;
    var output = [];
    records.forEach(function (record) {
      var clean = validateLegacyRecord(record);
      var key = recordKey(clean.recordType, clean.recordId);
      if (seen[key]) throwNas('DUPLICATE_RECORD');
      seen[key] = true;
      payloadBytes += utf8ByteLength(canonicalJson(clean.payload));
      if (payloadBytes > MAX_PAYLOAD_BYTES) throwNas('PAYLOAD_LIMIT');
      output.push(clean);
    });
    return output;
  }

  function validateMetaPayload(payload) {
    if (!isPlainObject(payload)) throwNas('MALFORMED_ROW');
    checkObjectShape(payload);
    Object.getOwnPropertyNames(payload).forEach(function (key) {
      if (!META_LOOKUP[key]) throwNas('MALFORMED_ROW');
    });
  }

  function cloneAndFreeze(value, seen) {
    if (!isObject(value)) return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) return value;
    seen.push(value);
    Object.getOwnPropertyNames(value).forEach(function (key) {
      cloneAndFreeze(value[key], seen);
    });
    Object.freeze(value);
    return value;
  }

  function detached(value) {
    return cloneValue(value, []);
  }

  function keyNames(userId) {
    return {
      records: PREFIX + userId + ':records',
      queue: PREFIX + userId + ':queue',
      recovery: PREFIX + userId + ':recovery',
      cursor: PREFIX + userId + ':cursor'
    };
  }

  function normaliseAuthData(result) {
    if (result && isObject(result) && hasOwn(result, 'error') && result.error) {
      throwNas('AUTH_FAILED');
    }
    if (result && isObject(result) && hasOwn(result, 'data')) return result.data;
    return result;
  }

  function normaliseRpcData(result) {
    if (result && isObject(result) && hasOwn(result, 'error') && result.error) {
      var rpcError = result.error;
      var rpcText = '';
      if (rpcError && rpcError.code) rpcText += String(rpcError.code).toUpperCase();
      if (rpcError && rpcError.message) rpcText += ' ' + String(rpcError.message).toUpperCase();
      if (/CONFLICT|CAS|VERSION|TOMBSTONED|ALREADY_DELETED|ALREADY_LIVE/.test(rpcText)) {
        throwNas('CAS_FAILED');
      }
      throwNas('RPC_FAILED');
    }
    if (result && isObject(result) && hasOwn(result, 'data')) return result.data;
    return result;
  }

  function actionRow(data) {
    if (Array.isArray(data)) {
      if (data.length !== 1) throwNas('MALFORMED_ROW');
      return data[0];
    }
    return data;
  }

  function pageRows(data) {
    if (!Array.isArray(data)) throwNas('MALFORMED_PAGE');
    if (data.length > PAGE_SIZE) throwNas('MALFORMED_PAGE');
    return data;
  }

  function pageSnapshot(rows) {
    var snapshot = null;
    rows.forEach(function (row) {
      if (!isPlainObject(row) || !hasOwn(row, 'snapshot_sequence')) {
        throwNas('SNAPSHOT_MISSING');
      }
      var rowSnapshot = parseSnapshot(row.snapshot_sequence);
      if (snapshot === null) snapshot = rowSnapshot;
      else if (rowSnapshot !== snapshot) throwNas('SNAPSHOT_CHANGED');
    });
    return snapshot;
  }

  function parseSnapshot(value) {
    try {
      return parseInteger(value, 0);
    } catch (_) {
      throwNas('MALFORMED_SNAPSHOT');
    }
  }

  function boundaryValue(data) {
    if (Array.isArray(data)) {
      if (data.length !== 1) throwNas('MALFORMED_BOUNDARY');
      data = data[0];
    }
    if (isPlainObject(data)) {
      if (hasOwn(data, 'boundary')) data = data.boundary;
      else if (hasOwn(data, 'change_seq')) data = data.change_seq;
      else if (hasOwn(data, 'max_change_seq')) data = data.max_change_seq;
    }
    try {
      return parseInteger(data, 0);
    } catch (_) {
      throwNas('MALFORMED_BOUNDARY');
    }
  }

  function createController(options) {
    options = options || {};
    var client = options.client;
    var storage = options.storage;
    var migration = options.migration;
    var encryption = options.encryption;
    var now = typeof options.now === 'function' ? options.now : function () { return new Date(); };
    var previewGuard = typeof options.isLocalPreview === 'function'
      ? options.isLocalPreview
      : function () {
        /* Node has no location, so synthetic controller tests stay usable.
           Browser callers get a defence-in-depth guard even if they forget
           to pass the app's explicit preview predicate. */
        try {
          var locationValue = typeof location === 'object' ? location : null;
          if (!locationValue) return false;
          return locationValue.protocol === 'file:'
            || locationValue.hostname === 'localhost'
            || locationValue.hostname === '127.0.0.1';
        } catch (_) {
          /* A failed environment check must fail closed for remote writes. */
          return true;
        }
      };
    var signOutFlushTimeoutMs = Number.isFinite(Number(options.signOutFlushTimeoutMs))
      ? Math.max(1, Math.min(120000, Number(options.signOutFlushTimeoutMs))) : 30000;

    if (!client || typeof client.rpc !== 'function' || !client.auth) throwNas('CLIENT_REQUIRED');
    if (!storage || typeof storage.getItem !== 'function'
      || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
      throwNas('STORAGE_REQUIRED');
    }
    var protectedStorage = false;
    try {
      protectedStorage = storage.isProtectedStorage === true;
    } catch (_) {}
    if (!protectedStorage) throwNas('PROTECTED_STORAGE_REQUIRED');
    if (!migration || typeof migration.planLegacyImport !== 'function') throwNas('MIGRATION_REQUIRED');
    if (!encryption || typeof encryption.isEnabled !== 'function'
      || typeof encryption.isUnlocked !== 'function') throwNas('ENCRYPTION_REQUIRED');

    var auth = client.auth;
    var lastUserId = null;
    var baseline = null;
    var baselineRows = null;
    var cursor = 0;
    var queueState = null;
    var ownerVerified = false;
    var offlineStageReady = false;
    var ownerBoundary = null;
    var flushPromise = null;
    var durabilityTail = Promise.resolve();
    var durabilityFailures = [];
    var lifecycleGeneration = 0;
    var signingOut = false;
    var signedOut = false;

    function assertWriteAllowed() {
      var preview = false;
      try { preview = previewGuard() === true; } catch (_) { preview = true; }
      if (preview) throwNas('PREVIEW_BLOCKED');
    }

    function withTimeout(promise, timeoutMs, code) {
      var timeout;
      var limit = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 30000;
      var timeoutPromise = new Promise(function (_, reject) {
        timeout = setTimeout(function () { reject(nasError(code || 'TIMEOUT')); }, limit);
      });
      return Promise.race([promise, timeoutPromise]).finally(function () {
        clearTimeout(timeout);
      });
    }

    function assertEncryption() {
      var enabled = false;
      var unlocked = false;
      try {
        enabled = encryption.isEnabled() === true;
        unlocked = encryption.isUnlocked() === true;
      } catch (_) {
        throwNas('ENCRYPTION_LOCKED');
      }
      if (!enabled || !unlocked) throwNas('ENCRYPTION_LOCKED');
    }

    function storageGet(key) {
      assertEncryption();
      try {
        var value = storage.getItem(key);
        if (value && typeof value.then === 'function') throwNas('STORAGE_ASYNC');
        return value == null ? null : value;
      } catch (error) {
        if (error && error.code && String(error.code).indexOf('PORTFOLIO_NAS_') === 0) throw error;
        throwNas('STORAGE_FAILED');
      }
    }

    function enqueueDurability(work) {
      var task = durabilityTail.then(work, work);
      durabilityTail = task.then(function () {}, function (error) {
        durabilityFailures.push(error);
      });
      return task;
    }

    async function waitForDurability() {
      await durabilityTail;
      if (durabilityFailures.length) throw durabilityFailures.shift();
    }

    function storageSet(key, value) {
      assertWriteAllowed();
      assertEncryption();
      return enqueueDurability(async function () {
        assertWriteAllowed();
        assertEncryption();
        try {
          await storage.setItem(key, value);
          if (typeof encryption.flush === 'function') await encryption.flush();
        } catch (error) {
          if (error && error.code && String(error.code).indexOf('PORTFOLIO_NAS_') === 0) throw error;
          throwNas('STORAGE_FAILED');
        }
      });
    }

    function storageRemove(key) {
      assertWriteAllowed();
      assertEncryption();
      return enqueueDurability(async function () {
        assertWriteAllowed();
        assertEncryption();
        try {
          await storage.removeItem(key);
          if (typeof encryption.flush === 'function') await encryption.flush();
        } catch (error) {
          if (error && error.code && String(error.code).indexOf('PORTFOLIO_NAS_') === 0) throw error;
          throwNas('STORAGE_FAILED');
        }
      });
    }

    function decodeStored(raw, code) {
      if (raw == null) return null;
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw);
        } catch (_) {
          throwNas(code || 'MALFORMED_STATE');
        }
      }
      if (isObject(raw)) return detached(raw);
      throwNas(code || 'MALFORMED_STATE');
    }

    function encodeStored(value) {
      try {
        return JSON.stringify(value);
      } catch (_) {
        throwNas('MALFORMED_STATE');
      }
    }

    async function clearCacheKeys(userId) {
      var keys = keyNames(validateUserId(userId));
      var firstError = null;
      for (var i = 0; i < 2; i += 1) {
        var key = i === 0 ? keys.records : keys.cursor;
        try {
          await storageRemove(key);
        } catch (error) {
          if (!firstError) firstError = error;
        }
      }
      if (firstError) throw firstError;
    }

    function setCurrentUser(userId) {
      validateUserId(userId);
      if (lastUserId && lastUserId !== userId) {
        /* A newly observed Auth identity must never be allowed to delete the
           previous identity's protected namespace.  The old bytes remain
           available to that identity if it is authenticated again. */
        baseline = null;
        baselineRows = null;
        cursor = 0;
        queueState = null;
        ownerVerified = false;
        offlineStageReady = false;
        ownerBoundary = null;
        lifecycleGeneration += 1;
      }
      lastUserId = userId;
      return userId;
    }

    async function authCall(methodName, args) {
      if (!auth || typeof auth[methodName] !== 'function') throwNas('AUTH_UNAVAILABLE');
      var result;
      try {
        result = await auth[methodName](args);
      } catch (_) {
        throwNas('AUTH_FAILED');
      }
      try {
        return normaliseAuthData(result);
      } catch (error) {
        if (error && error.code && String(error.code).indexOf('PORTFOLIO_NAS_') === 0) throw error;
        throwNas('AUTH_FAILED');
      }
    }

    async function rpcCall(name, args) {
      var result;
      try {
        result = await client.rpc(name, args || {});
      } catch (error) {
        var thrownText = '';
        if (error && error.code) thrownText += String(error.code).toUpperCase();
        if (error && error.message) thrownText += ' ' + String(error.message).toUpperCase();
        if (/CONFLICT|CAS|VERSION|TOMBSTONED|ALREADY_DELETED|ALREADY_LIVE/.test(thrownText)) {
          throwNas('CAS_FAILED');
        }
        throwNas('RPC_FAILED');
      }
      try {
        return normaliseRpcData(result);
      } catch (error) {
        if (error && error.code && String(error.code).indexOf('PORTFOLIO_NAS_') === 0) throw error;
        throwNas('RPC_FAILED');
      }
    }

    async function getAuthenticatedUser() {
      var data = await authCall('getUser');
      ensureSessionOpen();
      var user = data && isObject(data) && hasOwn(data, 'user') ? data.user : data;
      if (!isPlainObject(user) || typeof user.id !== 'string') throwNas('AUTH_REQUIRED');
      var userId;
      try {
        userId = validateUserId(user.id);
      } catch (_) {
        throwNas('UNSAFE_USER');
      }
      setCurrentUser(userId);
      return { id: userId };
    }

    async function assuranceData() {
      assertWriteAllowed();
      if (!auth.mfa || typeof auth.mfa.getAuthenticatorAssuranceLevel !== 'function') {
        throwNas('AAL2_REQUIRED');
      }
      var data;
      try {
        data = await auth.mfa.getAuthenticatorAssuranceLevel();
      } catch (_) {
        throwNas('AAL2_REQUIRED');
      }
      try {
        data = normaliseAuthData(data) || {};
      } catch (_) {
        throwNas('AAL2_REQUIRED');
      }
      var currentLevel = data && data.currentLevel;
      var nextLevel = data && data.nextLevel;
      if (typeof currentLevel !== 'string') throwNas('AAL2_REQUIRED');
      return { currentLevel: currentLevel, nextLevel: typeof nextLevel === 'string' ? nextLevel : null };
    }

    async function ownerGate() {
      /* The preview boundary covers reads as well as writes, because owner
         identity and finance rows must never leave a local QA origin. */
      assertWriteAllowed();
      assertEncryption();
      ownerVerified = false;
      ownerBoundary = null;
      var user = await getAuthenticatedUser();
      var assurance = await assuranceData();
      ensureSessionOpen();
      if (assurance.currentLevel !== 'aal2') throwNas('AAL2_REQUIRED');
      var boundary;
      try {
        boundary = boundaryValue(await rpcCall('portfolio_sync_boundary', {}));
        ensureSessionOpen();
      } catch (error) {
        if (error && error.code === 'PORTFOLIO_NAS_MALFORMED_BOUNDARY') throw error;
        if (error && error.code && String(error.code).indexOf('PORTFOLIO_NAS_') === 0) {
          if (error.code === 'PORTFOLIO_NAS_RPC_FAILED'
            || error.code === 'PORTFOLIO_NAS_CAS_FAILED') throwNas('BOUNDARY_FAILED');
          throw error;
        }
        throwNas('BOUNDARY_FAILED');
      }
      ownerVerified = true;
      ownerBoundary = boundary;
      return { userId: user.id, boundary: boundary };
    }

    function readRecords(userId) {
      var keys = keyNames(userId);
      var raw = storageGet(keys.records);
      var envelope = decodeStored(raw, 'MALFORMED_CACHE');
      if (envelope === null) {
        return { rows: [], baselineRows: [], cursor: 0 };
      }
      if (!isPlainObject(envelope) || !Array.isArray(envelope.rows)
        || !Array.isArray(envelope.baseline)) throwNas('MALFORMED_CACHE');
      var rows = validateRows(envelope.rows, userId);
      var baselineRowsValue = validateRows(envelope.baseline, userId);
      var baselineMap = mapRows(baselineRowsValue);
      var cacheMap = mapRows(rows);
      Object.keys(cacheMap).forEach(function (key) {
        if (!baselineMap[key]) throwNas('MALFORMED_CACHE');
      });
      Object.keys(baselineMap).forEach(function (key) {
        if (!cacheMap[key]) throwNas('MALFORMED_CACHE');
      });
      var storedCursor = envelope.cursor;
      if (storedCursor === undefined) storedCursor = decodeStored(storageGet(keys.cursor), 'MALFORMED_CURSOR');
      var localCursor = parseInteger(storedCursor, 0);
      var maximumSeq = 0;
      baselineRowsValue.forEach(function (row) {
        if (row.change_seq > maximumSeq) maximumSeq = row.change_seq;
      });
      if (localCursor < maximumSeq) throwNas('MALFORMED_CACHE');
      return { rows: rows, baselineRows: baselineRowsValue, baseline: baselineMap, cursor: localCursor };
    }

    function validateRows(rows, userId) {
      if (!Array.isArray(rows) || rows.length > MAX_RECORDS) throwNas('RECORD_LIMIT');
      var seen = Object.create(null);
      var bytes = 0;
      var output = [];
      var previousSeq = 0;
      rows.forEach(function (row) {
        var clean = validateServerRow(row, userId);
        var key = recordKey(clean.record_type, clean.record_id);
        if (seen[key]) throwNas('DUPLICATE_RECORD');
        seen[key] = true;
        if (clean.change_seq < previousSeq) throwNas('CURSOR_REGRESSION');
        previousSeq = clean.change_seq;
        bytes += utf8ByteLength(canonicalJson(clean.payload));
        if (bytes > MAX_PAYLOAD_BYTES) throwNas('PAYLOAD_LIMIT');
        output.push(clean);
      });
      return output;
    }

    function mapRows(rows) {
      var map = Object.create(null);
      rows.forEach(function (row) {
        map[recordKey(row.record_type, row.record_id)] = detached(row);
      });
      return map;
    }

    function rowsFromMap(map) {
      return Object.keys(map).map(function (key) { return detached(map[key]); }).sort(function (left, right) {
        if (left.change_seq !== right.change_seq) return left.change_seq - right.change_seq;
        if (left.record_type !== right.record_type) return left.record_type < right.record_type ? -1 : 1;
        return left.record_id < right.record_id ? -1 : left.record_id > right.record_id ? 1 : 0;
      });
    }

    function payloadAndPositionDiffer(record, row) {
      return record.position !== row.position
        || canonicalJson(record.payload) !== canonicalJson(row.payload);
    }

    function operation(kind, record, expectedVersion) {
      var output = {
        kind: kind,
        recordType: record.recordType,
        recordId: record.recordId,
        expectedVersion: expectedVersion
      };
      if (kind === 'upsert' || kind === 'restore') {
        output.payload = detached(record.payload);
        output.position = record.position;
      }
      return output;
    }

    function deriveOperations(desiredRecords, baselineMap) {
      var operations = [];
      var desiredMap = Object.create(null);
      desiredRecords.forEach(function (record) {
        var key = recordKey(record.recordType, record.recordId);
        desiredMap[key] = true;
        var live = baselineMap[key];
        if (!live) {
          operations.push(operation('upsert', record, 0));
        } else if (live.deleted_at !== null) {
          operations.push(operation('restore', record, live.version));
        } else if (payloadAndPositionDiffer(record, live)) {
          operations.push(operation('upsert', record, live.version));
        }
      });
      Object.keys(baselineMap).sort().forEach(function (key) {
        var live = baselineMap[key];
        if (!desiredMap[key] && live.deleted_at === null) {
          operations.push(operation('delete', {
            recordType: live.record_type,
            recordId: live.record_id
          }, live.version));
        }
      });
      if (operations.length > MAX_QUEUE) throwNas('QUEUE_LIMIT');
      return operations;
    }

    function validateOperation(value) {
      if (!isPlainObject(value)) throwNas('MALFORMED_QUEUE');
      checkObjectShape(value);
      if (value.kind !== 'upsert' && value.kind !== 'delete' && value.kind !== 'restore') {
        throwNas('MALFORMED_QUEUE');
      }
      if (hasOwn(value, 'user_id') || hasOwn(value, 'userId')) throwNas('MALFORMED_QUEUE');
      if (typeof value.recordType !== 'string' || !SUPPORTED[value.recordType]) {
        throwNas('MALFORMED_QUEUE');
      }
      validateRecordId(value.recordId);
      var expectedVersion = parseInteger(value.expectedVersion, 0);
      var output = {
        kind: value.kind,
        recordType: value.recordType,
        recordId: value.recordId,
        expectedVersion: expectedVersion
      };
      if (value.kind === 'upsert' || value.kind === 'restore') {
        if (!isPlainObject(value.payload)) throwNas('MALFORMED_QUEUE');
        output.payload = cloneValue(value.payload, []);
        output.position = parseInteger(value.position, 0);
      }
      return output;
    }

    function loadQueue(userId) {
      var raw = storageGet(keyNames(userId).queue);
      var value = decodeStored(raw, 'MALFORMED_QUEUE');
      if (value === null) return null;
      if (!isPlainObject(value)) throwNas('MALFORMED_QUEUE');
      checkObjectShape(value);
      var generation = parseInteger(value.generation, 0);
      var desired = validateRecordList(value.desiredRecords, MAX_RECORDS);
      if (!Array.isArray(value.operations) || value.operations.length > MAX_QUEUE) {
        throwNas('MALFORMED_QUEUE');
      }
      var operations = value.operations.map(validateOperation);
      var payloadBytes = 0;
      desired.forEach(function (record) {
        payloadBytes += utf8ByteLength(canonicalJson(record.payload));
      });
      if (payloadBytes > MAX_PAYLOAD_BYTES) throwNas('PAYLOAD_LIMIT');
      return { generation: generation, desiredRecords: desired, operations: operations };
    }

    async function persistQueue(userId, state, oldRaw) {
      var key = keyNames(userId).queue;
      var encoded = encodeStored(state);
      try {
        await storageSet(key, encoded);
      } catch (error) {
        try {
          if (oldRaw == null) await storageRemove(key);
          else await storageSet(key, oldRaw);
        } catch (_) {}
        throw error;
      }
    }

    async function persistRecords(userId, rows, baselineRowsValue, nextCursor) {
      var keys = keyNames(userId);
      var oldRowsRaw = storageGet(keys.records);
      var oldCursorRaw = storageGet(keys.cursor);
      var envelope = {
        rows: detached(rows),
        baseline: detached(baselineRowsValue),
        cursor: nextCursor
      };
      var encoded = encodeStored(envelope);
      try {
        await storageSet(keys.records, encoded);
        await storageSet(keys.cursor, encodeStored(nextCursor));
      } catch (error) {
        try {
          if (oldRowsRaw == null) await storageRemove(keys.records);
          else await storageSet(keys.records, oldRowsRaw);
          if (oldCursorRaw == null) await storageRemove(keys.cursor);
          else await storageSet(keys.cursor, oldCursorRaw);
        } catch (_) {}
        throw error;
      }
    }

    function reconstructDb(rows) {
      var db = {};
      ARRAY_TYPES.forEach(function (name) { db[name] = []; });
      SINGLETON_TYPES.forEach(function (name) { db[name] = {}; });
      var arrays = Object.create(null);
      ARRAY_TYPES.forEach(function (name) { arrays[name] = []; });
      rows.forEach(function (row) {
        if (row.deleted_at !== null) return;
        if (row.record_type === '_syncMeta') {
          validateMetaPayload(row.payload);
          Object.keys(row.payload).forEach(function (key) {
            db[key] = detached(row.payload[key]);
          });
          return;
        }
        if (ARRAY_LOOKUP[row.record_type]) {
          arrays[row.record_type].push(row);
        } else if (SINGLETON_LOOKUP[row.record_type]) {
          db[row.record_type] = detached(row.payload);
        }
      });
      ARRAY_TYPES.forEach(function (name) {
        arrays[name].sort(function (left, right) {
          if (left.position !== right.position) return left.position - right.position;
          return left.record_id < right.record_id ? -1 : left.record_id > right.record_id ? 1 : 0;
        });
        db[name] = arrays[name].map(function (row) { return detached(row.payload); });
      });
      return db;
    }

    function reconstructDesiredDb(records) {
      var db = {};
      ARRAY_TYPES.forEach(function (name) { db[name] = []; });
      SINGLETON_TYPES.forEach(function (name) { db[name] = {}; });
      var arrays = Object.create(null);
      ARRAY_TYPES.forEach(function (name) { arrays[name] = []; });
      records.forEach(function (record) {
        if (record.recordType === '_syncMeta') {
          validateMetaPayload(record.payload);
          Object.keys(record.payload).forEach(function (key) {
            db[key] = detached(record.payload[key]);
          });
          return;
        }
        if (ARRAY_LOOKUP[record.recordType]) {
          arrays[record.recordType].push(record);
        } else if (SINGLETON_LOOKUP[record.recordType]) {
          db[record.recordType] = detached(record.payload);
        }
      });
      ARRAY_TYPES.forEach(function (name) {
        arrays[name].sort(function (left, right) {
          if (left.position !== right.position) return left.position - right.position;
          return left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0;
        });
        db[name] = arrays[name].map(function (record) { return detached(record.payload); });
      });
      return db;
    }

    function planInput(db) {
      var plan;
      try {
        plan = migration.planLegacyImport(db);
      } catch (_) {
        throwNas('IMPORT_INVALID');
      }
      if (!plan || !Array.isArray(plan.records)) throwNas('IMPORT_INVALID');
      var records;
      try {
        records = validateRecordList(plan.records, MAX_RECORDS);
      } catch (error) {
        if (error && (error.code === 'PORTFOLIO_NAS_RECORD_LIMIT'
          || error.code === 'PORTFOLIO_NAS_PAYLOAD_LIMIT')) throw error;
        throwNas('IMPORT_INVALID');
      }
      return {
        records: records,
        sourceHash: typeof plan.sourceHash === 'string' ? plan.sourceHash : null,
        recordsHash: typeof plan.recordsHash === 'string' ? plan.recordsHash : null
      };
    }

    function recoveryDb(db) {
      var copy = detached(db);
      if (isPlainObject(copy) && hasOwn(copy, '_priceCache')) delete copy._priceCache;
      return copy;
    }

    function isRecoveryReason(reason) {
      return reason === 'before-hydrate' || reason === 'before-import' || reason === 'conflict';
    }

    function validateRecoveryEntry(value) {
      if (!isPlainObject(value)) throwNas('MALFORMED_RECOVERY');
      try {
        checkObjectShape(value);
      } catch (_) {
        throwNas('MALFORMED_RECOVERY');
      }
      ['createdAt', 'reason', 'sourceHash', 'recordsHash', 'db'].forEach(function (key) {
        if (!hasOwn(value, key)) throwNas('MALFORMED_RECOVERY');
      });
      Object.getOwnPropertyNames(value).forEach(function (key) {
        if (key !== 'createdAt' && key !== 'reason' && key !== 'sourceHash'
          && key !== 'recordsHash' && key !== 'db') throwNas('MALFORMED_RECOVERY');
      });
      if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) {
        throwNas('MALFORMED_RECOVERY');
      }
      if (!isRecoveryReason(value.reason)) throwNas('MALFORMED_RECOVERY');
      if (value.sourceHash !== null && typeof value.sourceHash !== 'string') {
        throwNas('MALFORMED_RECOVERY');
      }
      if (value.recordsHash !== null && typeof value.recordsHash !== 'string') {
        throwNas('MALFORMED_RECOVERY');
      }
      if (!isPlainObject(value.db)) throwNas('MALFORMED_RECOVERY');
      var db;
      try {
        db = detached(value.db);
      } catch (_) {
        throwNas('MALFORMED_RECOVERY');
      }
      if (hasOwn(db, '_priceCache')) throwNas('MALFORMED_RECOVERY');
      return {
        createdAt: value.createdAt,
        reason: value.reason,
        sourceHash: value.sourceHash,
        recordsHash: value.recordsHash,
        db: db
      };
    }

    function loadRecoveryJournal(userId, rawValue) {
      var raw = arguments.length > 1 ? rawValue : storageGet(keyNames(userId).recovery);
      var value;
      try {
        value = decodeStored(raw, 'MALFORMED_RECOVERY');
      } catch (error) {
        if (error && error.code === 'PORTFOLIO_NAS_MALFORMED_RECOVERY') throw error;
        throwNas('MALFORMED_RECOVERY');
      }
      if (value === null) return [];
      if (Array.isArray(value)) {
        if (value.length > MAX_RECOVERY) throwNas('MALFORMED_RECOVERY');
        return value.map(validateRecoveryEntry);
      }
      return [validateRecoveryEntry(value)];
    }

    async function appendRecovery(userId, reason, db, sourceHash, recordsHash, lifecycle) {
      if (lifecycle !== undefined && !lifecycleIsCurrent(lifecycle)) throwNas('SESSION_CLOSED');
      var timestamp;
      try {
        timestamp = now();
        if (timestamp instanceof Date) timestamp = timestamp.toISOString();
        else if (typeof timestamp === 'number') timestamp = new Date(timestamp).toISOString();
        else if (typeof timestamp !== 'string' || !timestamp) throw new Error('time');
      } catch (_) {
        throwNas('RECOVERY_TIME');
      }
      var recovery = validateRecoveryEntry({
        createdAt: timestamp,
        reason: reason,
        sourceHash: sourceHash == null ? null : sourceHash,
        recordsHash: recordsHash == null ? null : recordsHash,
        db: recoveryDb(db)
      });
      var key = keyNames(validateUserId(userId)).recovery;
      var oldRaw = storageGet(key);
      var journal = loadRecoveryJournal(userId, oldRaw);
      journal.push(recovery);
      if (journal.length > MAX_RECOVERY) journal.shift();
      var encoded = encodeStored(journal);
      try {
        await storageSet(key, encoded);
      } catch (error) {
        try {
          if (oldRaw == null) await storageRemove(key);
          else await storageSet(key, oldRaw);
        } catch (_) {}
        throw error;
      }
      if (lifecycle !== undefined && !lifecycleIsCurrent(lifecycle)) throwNas('SESSION_CLOSED');
      return recovery;
    }

    function ensureBaselineLoaded(userId) {
      if (baseline !== null && baselineRows !== null && lastUserId === userId) return;
      var local = readRecords(userId);
      baseline = local.baseline || mapRows(local.baselineRows);
      baselineRows = local.baselineRows;
      cursor = local.cursor;
    }

    async function hydrateWithGate(gate, gateGeneration) {
      if (!lifecycleIsCurrent(gateGeneration)) throwNas('SESSION_CLOSED');
      var rows = [];
      var seen = Object.create(null);
      var rowMap = Object.create(null);
      var pageCursor = 0;
      var snapshotSequence = null;
      var firstPage = true;
      while (firstPage || pageCursor < snapshotSequence) {
        var pageData;
        try {
          var pageArgs = {
            p_after_change_seq: pageCursor,
            p_snapshot_sequence: firstPage ? null : snapshotSequence,
            p_limit: PAGE_SIZE
          };
          pageData = await rpcCall('portfolio_get_records_page', pageArgs);
        } catch (error) {
          throw error;
        }
        if (!lifecycleIsCurrent(gateGeneration)) throwNas('SESSION_CLOSED');
        var page = pageRows(pageData);
        var pageSnapshotValue = pageSnapshot(page);
        if (firstPage) {
          snapshotSequence = pageSnapshotValue === null ? gate.boundary : pageSnapshotValue;
          firstPage = false;
        } else if (pageSnapshotValue !== null) {
          if (pageSnapshotValue < snapshotSequence) throwNas('SNAPSHOT_REGRESSION');
          if (pageSnapshotValue !== snapshotSequence) throwNas('SNAPSHOT_CHANGED');
        }
        if (page.length === 0) break;
        var previous = pageCursor;
        page.forEach(function (rawRow) {
          var row = validateServerRow(rawRow, gate.userId);
          if (row.change_seq <= pageCursor || row.change_seq > snapshotSequence) {
            throwNas('CURSOR_REGRESSION');
          }
          var key = recordKey(row.record_type, row.record_id);
          if (seen[key]) throwNas('DUPLICATE_RECORD');
          seen[key] = true;
          rows.push(row);
          rowMap[key] = row;
          if (rows.length > MAX_RECORDS) throwNas('RECORD_LIMIT');
          pageCursor = row.change_seq;
        });
        if (pageCursor <= previous) throwNas('CURSOR_REGRESSION');
      }

      /* A record can be updated or tombstoned between two pages.  The
         snapshot query reads the current row, so its old change_seq can
         disappear from the remainder of the frozen range and leave a cursor
         gap.  Only when the original pass has such a gap do we drain a live
         page tail above the original snapshot.  This uses the same owner/AAL2
         page RPC, never a second standalone boundary call that could advance
         past an uncommitted change.  A short two-empty-epoch stabilisation
         check catches a row moved again while the tail is being read, while
         the pass bound fails closed under a continuously changing backend. */
      if (pageCursor < snapshotSequence) {
        var tailCursor = snapshotSequence;
        var emptyTailEpochs = 0;
        var tailStable = false;
        for (var tailPass = 0; tailPass < 4 && !tailStable; tailPass += 1) {
          var epochStart = tailCursor;
          var tailSnapshot = null;
          var tailFirstPage = true;
          var tailHadRows = false;
          while (tailFirstPage || tailCursor < tailSnapshot) {
            var tailArgs = {
              p_after_change_seq: tailCursor,
              p_snapshot_sequence: tailFirstPage ? null : tailSnapshot,
              p_limit: PAGE_SIZE
            };
            var tailData = await rpcCall('portfolio_get_records_page', tailArgs);
            if (!lifecycleIsCurrent(gateGeneration)) throwNas('SESSION_CLOSED');
            var tailPage = pageRows(tailData);
            var tailPageSnapshot = pageSnapshot(tailPage);
            if (tailFirstPage) {
              tailSnapshot = tailPageSnapshot === null ? tailCursor : tailPageSnapshot;
              tailFirstPage = false;
            } else if (tailPageSnapshot !== null) {
              if (tailPageSnapshot < tailSnapshot) throwNas('SNAPSHOT_REGRESSION');
              if (tailPageSnapshot !== tailSnapshot) throwNas('SNAPSHOT_CHANGED');
            }
            if (tailPage.length === 0) break;
            var previousTail = tailCursor;
            tailPage.forEach(function (rawRow) {
              var row = validateServerRow(rawRow, gate.userId);
              if (row.change_seq <= tailCursor || row.change_seq > tailSnapshot) {
                throwNas('CURSOR_REGRESSION');
              }
              var key = recordKey(row.record_type, row.record_id);
              var prior = rowMap[key];
              if (prior && row.change_seq <= prior.change_seq) {
                throwNas('CURSOR_REGRESSION');
              }
              rowMap[key] = row;
              tailHadRows = true;
              tailCursor = row.change_seq;
            });
            if (tailCursor <= previousTail) throwNas('CURSOR_REGRESSION');
          }
          if (tailSnapshot === null) throwNas('SNAPSHOT_MISSING');
          /* No row in the current owner's range may be skipped.  Advancing
             over an empty tail is safe because the next epoch starts at the
             captured snapshot and catches a row that moved beyond it during
             the preceding query. */
          if (tailCursor < tailSnapshot) tailCursor = tailSnapshot;
          else if (tailSnapshot > tailCursor) tailCursor = tailSnapshot;
          if (!tailHadRows && tailSnapshot <= epochStart) emptyTailEpochs += 1;
          else emptyTailEpochs = 0;
          tailStable = emptyTailEpochs >= 2;
        }
        if (!tailStable) throwNas('SNAPSHOT_CHANGED');
        snapshotSequence = tailCursor;
        rows = Object.keys(rowMap).map(function (key) { return rowMap[key]; });
      }
      var db = reconstructDb(rows);
      if (!lifecycleIsCurrent(gateGeneration)) throwNas('SESSION_CLOSED');
      var nextBaseline = mapRows(rows);
      var nextRows = rowsFromMap(nextBaseline);
      var keys = keyNames(gate.userId);
      var oldRowsRaw = storageGet(keys.records);
      var oldCursorRaw = storageGet(keys.cursor);
      try {
        var envelope = {
          rows: detached(nextRows),
          baseline: detached(nextRows),
          cursor: snapshotSequence
        };
        await storageSet(keys.records, encodeStored(envelope));
        await storageSet(keys.cursor, encodeStored(snapshotSequence));
      } catch (error) {
        try {
          if (oldRowsRaw == null) await storageRemove(keys.records);
          else await storageSet(keys.records, oldRowsRaw);
          if (oldCursorRaw == null) await storageRemove(keys.cursor);
          else await storageSet(keys.cursor, oldCursorRaw);
        } catch (_) {}
        throw error;
      }
      if (!lifecycleIsCurrent(gateGeneration)) throwNas('SESSION_CLOSED');
      baseline = nextBaseline;
      baselineRows = nextRows;
      cursor = snapshotSequence;
      offlineStageReady = true;
      return detached(db);
    }

    async function hydrate() {
      ensureSessionOpen();
      var gateGeneration = lifecycleGeneration;
      var gate = await ownerGate();
      return hydrateWithGate(gate, gateGeneration);
    }

    async function cached() {
      ensureSessionOpen();
      var gateGeneration = lifecycleGeneration;
      var gate = await ownerGate();
      if (!lifecycleIsCurrent(gateGeneration)) throwNas('SESSION_CLOSED');
      var local = readRecords(gate.userId);
      var cleanRows = validateRows(local.rows, gate.userId);
      baseline = local.baseline || mapRows(local.baselineRows);
      baselineRows = local.baselineRows;
      cursor = local.cursor;
      offlineStageReady = true;
      return detached(cleanRows);
    }

    async function pending() {
      ensureSessionOpen();
      var gateGeneration = lifecycleGeneration;
      var gate = await ownerGate();
      if (!lifecycleIsCurrent(gateGeneration)) throwNas('SESSION_CLOSED');
      var local = loadQueue(gate.userId);
      queueState = local;
      if (!local || local.operations.length === 0) {
        return { count: 0, desiredDb: null };
      }
      return {
        count: local.operations.length,
        desiredDb: detached(reconstructDesiredDb(local.desiredRecords))
      };
    }

    function pendingDesired(local) {
      if (!local || local.operations.length === 0) throwNas('NO_PENDING');
      return {
        records: detached(local.desiredRecords),
        db: reconstructDesiredDb(local.desiredRecords)
      };
    }

    function queueMatches(left, right) {
      return !!left && !!right
        && left.generation === right.generation
        && canonicalJson(left.desiredRecords) === canonicalJson(right.desiredRecords)
        && canonicalJson(left.operations) === canonicalJson(right.operations);
    }

    async function currentPendingQueue(userId, original) {
      await waitForDurability();
      var latest = loadQueue(userId);
      if (!queueMatches(original, latest)) throwNas('QUEUE_CHANGED');
      return latest;
    }

    async function rebasePending() {
      assertWriteAllowed();
      ensureSessionOpen();
      var lifecycle = lifecycleGeneration;
      var gate = await ownerGate();
      if (!lifecycleIsCurrent(lifecycle)) throwNas('SESSION_CLOSED');
      var local = loadQueue(gate.userId);
      var desired = pendingDesired(local);
      await appendRecovery(gate.userId, 'conflict', desired.db, null, null, lifecycle);
      if (!lifecycleIsCurrent(lifecycle)) throwNas('SESSION_CLOSED');
      await hydrateWithGate(gate, lifecycle);
      if (!lifecycleIsCurrent(lifecycle)) throwNas('SESSION_CLOSED');
      await currentPendingQueue(gate.userId, local);
      var state = await persistStage(gate.userId, { records: desired.records }, lifecycle);
      if (!lifecycleIsCurrent(lifecycle)) throwNas('SESSION_CLOSED');
      return {
        count: state.operations.length,
        desiredDb: detached(desired.db)
      };
    }

    async function clearPendingQueue(userId, oldRaw, lifecycle) {
      assertWriteAllowed();
      var key = keyNames(validateUserId(userId)).queue;
      try {
        await storageRemove(key);
        if (lifecycle !== undefined && !lifecycleIsCurrent(lifecycle)) {
          throwNas('SESSION_CLOSED');
        }
      } catch (error) {
        try {
          if (oldRaw == null) await storageRemove(key);
          else await storageSet(key, oldRaw);
        } catch (_) {}
        throw error;
      }
    }

    async function discardPending() {
      assertWriteAllowed();
      ensureSessionOpen();
      var lifecycle = lifecycleGeneration;
      var gate = await ownerGate();
      if (!lifecycleIsCurrent(lifecycle)) throwNas('SESSION_CLOSED');
      var local = loadQueue(gate.userId);
      var desired = pendingDesired(local);
      await appendRecovery(gate.userId, 'conflict', desired.db, null, null, lifecycle);
      if (!lifecycleIsCurrent(lifecycle)) throwNas('SESSION_CLOSED');
      var db = await hydrateWithGate(gate, lifecycle);
      if (!lifecycleIsCurrent(lifecycle)) throwNas('SESSION_CLOSED');
      await currentPendingQueue(gate.userId, local);
      var queueKey = keyNames(gate.userId).queue;
      var oldRaw = storageGet(queueKey);
      await clearPendingQueue(gate.userId, oldRaw, lifecycle);
      queueState = null;
      return detached(db);
    }

    async function listRecovery() {
      ensureSessionOpen();
      var lifecycle = lifecycleGeneration;
      var gate = await ownerGate();
      if (!lifecycleIsCurrent(lifecycle)) throwNas('SESSION_CLOSED');
      var journal = loadRecoveryJournal(gate.userId);
      return journal.map(function (entry, index) {
        return detached({
          index: index,
          createdAt: entry.createdAt,
          reason: entry.reason,
          sourceHash: entry.sourceHash,
          recordsHash: entry.recordsHash
        });
      });
    }

    async function restoreRecovery(index) {
      /* The returned recovery payload is local protected data, but this
         method is the restore boundary and must never be used as a write
         primitive by a preview origin. */
      assertWriteAllowed();
      if (typeof index !== 'number' || !Number.isSafeInteger || !Number.isSafeInteger(index)
        || index < 0) throwNas('RECOVERY_INDEX');
      ensureSessionOpen();
      var lifecycle = lifecycleGeneration;
      var gate = await ownerGate();
      if (!lifecycleIsCurrent(lifecycle)) throwNas('SESSION_CLOSED');
      var journal = loadRecoveryJournal(gate.userId);
      if (index >= journal.length) throwNas('RECOVERY_INDEX');
      return detached(journal[index].db);
    }

    function currentQueue(userId) {
      var local = loadQueue(userId);
      queueState = local;
      return local;
    }

    function ensureSessionOpen() {
      if (signingOut || signedOut) throwNas('SESSION_CLOSED');
    }

    function lifecycleIsCurrent(generation) {
      return generation === lifecycleGeneration && !signingOut && !signedOut;
    }

    async function persistStage(userId, plan, lifecycle) {
      assertWriteAllowed();
      ensureSessionOpen();
      ensureBaselineLoaded(userId);
      var prior = currentQueue(userId);
      var generation = prior ? prior.generation + 1 : 1;
      var operations = deriveOperations(plan.records, baseline);
      var desiredRecords = detached(plan.records);
      var state = {
        generation: generation,
        desiredRecords: desiredRecords,
        operations: detached(operations)
      };
      var queueKey = keyNames(userId).queue;
      var oldRaw = storageGet(queueKey);
      await persistQueue(userId, state, oldRaw);
      if (lifecycle === undefined || lifecycleIsCurrent(lifecycle)) queueState = state;
      return detached(state);
    }

    async function stage(db) {
      assertWriteAllowed();
      ensureSessionOpen();
      var stageLifecycle = lifecycleGeneration;
      /* The migration snapshot is intentionally the first operation.  A
         caller can edit the app DB while the user or vault checks await. */
      var plan = planInput(db);
      /* A successful owner hydration (or cached read) grants a deliberately
         narrow offline staging window.  It uses only the verified identity
         and in-memory baseline, never a new auth or RPC call. */
      if (offlineStageReady && lastUserId && baseline !== null) {
        assertEncryption();
        var offlineState = await persistStage(lastUserId, plan, stageLifecycle);
        if (!lifecycleIsCurrent(stageLifecycle)) throwNas('SESSION_CLOSED');
        return offlineState;
      }
      var gate = await ownerGate();
      ensureSessionOpen();
      var state = await persistStage(gate.userId, plan, stageLifecycle);
      if (!lifecycleIsCurrent(stageLifecycle)) throwNas('SESSION_CLOSED');
      offlineStageReady = true;
      return state;
    }

    function classifyFlushError(error) {
      if (error && error.code === 'PORTFOLIO_NAS_CAS_FAILED') return error;
      var code = error && error.code ? String(error.code) : '';
      if (code.indexOf('PORTFOLIO_NAS_') === 0) return error;
      return nasError('RPC_FAILED');
    }

    async function executeOperation(op, userId) {
      assertWriteAllowed();
      var args;
      var rpcName;
      if (op.kind === 'upsert') {
        rpcName = 'portfolio_upsert_record';
        args = {
          p_record_type: op.recordType,
          p_record_id: op.recordId,
          p_payload: detached(op.payload),
          p_position: op.position,
          p_expected_version: op.expectedVersion
        };
      } else if (op.kind === 'delete') {
        rpcName = 'portfolio_delete_record';
        args = {
          p_record_type: op.recordType,
          p_record_id: op.recordId,
          p_expected_version: op.expectedVersion
        };
      } else {
        rpcName = 'portfolio_restore_record';
        args = {
          p_record_type: op.recordType,
          p_record_id: op.recordId,
          p_payload: detached(op.payload),
          p_position: op.position,
          p_expected_version: op.expectedVersion
        };
      }
      var data;
      try {
        data = await rpcCall(rpcName, args);
      } catch (error) {
        var text = '';
        if (error && error.code) text += String(error.code).toUpperCase();
        if (error && error.message) text += ' ' + String(error.message).toUpperCase();
        if (/CONFLICT|CAS|VERSION|TOMBSTONED|ALREADY_DELETED|ALREADY_LIVE/.test(text)) {
          throwNas('CAS_FAILED');
        }
        throw error;
      }
      var row = validateServerRow(actionRow(data), userId);
      if (row.record_type !== op.recordType || row.record_id !== op.recordId) {
        throwNas('MALFORMED_ROW');
      }
      if (op.kind === 'delete' && row.deleted_at === null) throwNas('MALFORMED_ROW');
      if (op.kind !== 'delete' && row.deleted_at !== null) throwNas('MALFORMED_ROW');
      if (row.version <= op.expectedVersion) throwNas('MALFORMED_ROW');
      return row;
    }

    function flushSnapshot() {
      ensureSessionOpen();
      assertEncryption();
      if (!lastUserId) return {
        unresolvedUser: true,
        generation: 0,
        operations: [],
        desiredRecords: [],
        lifecycle: lifecycleGeneration
      };
      var local = currentQueue(lastUserId);
      if (!local) return {
        unresolvedUser: false,
        userId: lastUserId,
        generation: 0,
        operations: [],
        desiredRecords: [],
        lifecycle: lifecycleGeneration
      };
      return {
        unresolvedUser: false,
        userId: lastUserId,
        generation: local.generation,
        operations: detached(local.operations),
        desiredRecords: detached(local.desiredRecords),
        lifecycle: lifecycleGeneration
      };
    }

    async function runFlush(snapshot) {
      assertWriteAllowed();
      var gate = await ownerGate();
      if (!lifecycleIsCurrent(snapshot.lifecycle)) {
        return {
          generation: snapshot.generation,
          applied: 0,
          queued: snapshot.operations.length,
          cancelled: true
        };
      }
      if (snapshot.unresolvedUser) {
        snapshot.userId = gate.userId;
        var loadedQueue = currentQueue(gate.userId);
        snapshot.generation = loadedQueue ? loadedQueue.generation : 0;
        snapshot.operations = loadedQueue ? detached(loadedQueue.operations) : [];
        snapshot.desiredRecords = loadedQueue ? detached(loadedQueue.desiredRecords) : [];
      }
      if (!lifecycleIsCurrent(snapshot.lifecycle)) {
        return {
          generation: snapshot.generation,
          applied: 0,
          queued: snapshot.operations.length,
          cancelled: true
        };
      }
      if (snapshot.userId !== gate.userId) throwNas('USER_CHANGED');
      if (!snapshot.operations.length) {
        return {
          generation: snapshot.generation,
          applied: 0,
          queued: 0
        };
      }
      ensureBaselineLoaded(gate.userId);
      var applied = 0;
      var failure = null;
      for (var i = 0; i < snapshot.operations.length; i += 1) {
        var op = snapshot.operations[i];
        try {
          var row = await executeOperation(op, gate.userId);
          if (!lifecycleIsCurrent(snapshot.lifecycle)) {
            return {
              generation: snapshot.generation,
              applied: applied,
              queued: snapshot.operations.length - applied,
              cancelled: true
            };
          }
          baseline[recordKey(row.record_type, row.record_id)] = detached(row);
          applied += 1;
        } catch (error) {
          failure = classifyFlushError(error);
          break;
        }
      }
      if (!lifecycleIsCurrent(snapshot.lifecycle)) {
        return {
          generation: snapshot.generation,
          applied: applied,
          queued: snapshot.operations.length - applied,
          cancelled: true
        };
      }
      await waitForDurability();
      if (!lifecycleIsCurrent(snapshot.lifecycle)) {
        return {
          generation: snapshot.generation,
          applied: applied,
          queued: snapshot.operations.length - applied,
          cancelled: true
        };
      }
      var newest = currentQueue(gate.userId);
      var desired = newest ? newest.desiredRecords : snapshot.desiredRecords;
      var generation = newest ? newest.generation : snapshot.generation;
      var operations;
      try {
        operations = deriveOperations(desired, baseline);
      } catch (error) {
        throw error;
      }
      var nextRows = rowsFromMap(baseline);
      var nextCursor = cursor;
      nextRows.forEach(function (row) {
        if (row.change_seq > nextCursor) nextCursor = row.change_seq;
      });
      if (applied > 0) {
        await persistRecords(gate.userId, nextRows, nextRows, nextCursor);
        if (!lifecycleIsCurrent(snapshot.lifecycle)) {
          return {
            generation: snapshot.generation,
            applied: applied,
            queued: snapshot.operations.length - applied,
            cancelled: true
          };
        }
        baselineRows = nextRows;
        cursor = nextCursor;
      }
      var nextState = {
        generation: generation,
        desiredRecords: detached(desired),
        operations: detached(operations)
      };
      var oldQueueRaw = storageGet(keyNames(gate.userId).queue);
      await persistQueue(gate.userId, nextState, oldQueueRaw);
      if (!lifecycleIsCurrent(snapshot.lifecycle)) {
        return {
          generation: snapshot.generation,
          applied: applied,
          queued: snapshot.operations.length - applied,
          cancelled: true
        };
      }
      queueState = nextState;
      if (failure) throw failure;
      return {
        generation: generation,
        applied: applied,
        queued: operations.length
      };
    }

    function flush() {
      try {
        assertWriteAllowed();
        ensureSessionOpen();
      } catch (error) {
        return Promise.reject(error);
      }
      if (flushPromise) return flushPromise;
      var run = (async function () {
        await waitForDurability();
        ensureSessionOpen();
        var snapshot = flushSnapshot();
        return runFlush(snapshot);
      }());
      flushPromise = run.finally(function () {
        flushPromise = null;
      });
      return flushPromise;
    }

    async function stashRecovery(db, reason) {
      assertWriteAllowed();
      ensureSessionOpen();
      if (typeof reason !== 'string' || !isRecoveryReason(reason)) throwNas('RECOVERY_REASON');
      var plan = planInput(db);
      var gateGeneration = lifecycleGeneration;
      var gate = await ownerGate();
      if (!lifecycleIsCurrent(gateGeneration)) throwNas('SESSION_CLOSED');
      var recovery = await appendRecovery(
        gate.userId, reason, db, plan.sourceHash, plan.recordsHash, gateGeneration
      );
      return {
        createdAt: recovery.createdAt,
        reason: reason,
        sourceHash: plan.sourceHash,
        recordsHash: plan.recordsHash
      };
    }

    async function signInWithPassword(email, password) {
      assertWriteAllowed();
      if (typeof email !== 'string' || email.length === 0 || email.length > 254
        || email.indexOf('\u0000') !== -1 || email.indexOf(':') !== -1) {
        throwNas('AUTH_INPUT');
      }
      if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
        throwNas('AUTH_INPUT');
      }
      var data = await authCall('signInWithPassword', { email: email, password: password });
      var user = data && data.user;
      if (!isPlainObject(user) || typeof user.id !== 'string') throwNas('AUTH_REQUIRED');
      var userId;
      try {
        userId = validateUserId(user.id);
      } catch (_) {
        throwNas('UNSAFE_USER');
      }
      lifecycleGeneration += 1;
      signingOut = false;
      signedOut = false;
      ownerVerified = false;
      offlineStageReady = false;
      setCurrentUser(userId);
      return {
        user: { id: userId }
      };
    }

    async function getAssurance() {
      return detached(await assuranceData());
    }

    async function listTotpFactors() {
      assertWriteAllowed();
      if (!auth.mfa || typeof auth.mfa.listFactors !== 'function') throwNas('AUTH_UNAVAILABLE');
      var data;
      try {
        data = normaliseAuthData(await auth.mfa.listFactors());
      } catch (error) {
        if (error && error.code && String(error.code).indexOf('PORTFOLIO_NAS_') === 0) throw error;
        throwNas('AUTH_FAILED');
      }
      var factors = [];
      if (data && Array.isArray(data.totp)) factors = data.totp;
      else if (data && Array.isArray(data.all)) factors = data.all;
      else if (Array.isArray(data)) factors = data;
      return factors.filter(function (factor) {
        return factor && (factor.factor_type === 'totp' || factor.type === 'totp');
      }).map(function (factor) {
        var output = {};
        ['id', 'factor_type', 'type', 'status', 'friendly_name', 'created_at',
          'updated_at', 'verification_status'].forEach(function (key) {
          if (typeof factor[key] === 'string') output[key] = factor[key];
        });
        return output;
      }).map(function (factor) { return detached(factor); });
    }

    async function enrolTotp(friendlyName) {
      assertWriteAllowed();
      if (typeof friendlyName !== 'string' || friendlyName.length === 0
        || friendlyName.length > MAX_FRIENDLY_NAME) throwNas('AUTH_INPUT');
      for (var i = 0; i < friendlyName.length; i += 1) {
        if (friendlyName.charCodeAt(i) < 0x20 || friendlyName.charCodeAt(i) === 0x7F) {
          throwNas('AUTH_INPUT');
        }
      }
      if (!auth.mfa || typeof auth.mfa.enroll !== 'function') throwNas('AUTH_UNAVAILABLE');
      var data;
      try {
        data = normaliseAuthData(await auth.mfa.enroll({
          factorType: 'totp',
          friendlyName: friendlyName
        }));
      } catch (error) {
        if (error && error.code && String(error.code).indexOf('PORTFOLIO_NAS_') === 0) throw error;
        throwNas('AUTH_FAILED');
      }
      if (!isPlainObject(data) || typeof data.id !== 'string' || !isSafeRecordId(data.id)
        || !isPlainObject(data.totp)) throwNas('AUTH_FAILED');
      var totp = data.totp;
      if (typeof totp.qr_code !== 'string' || typeof totp.secret !== 'string'
        || typeof totp.uri !== 'string' || totp.qr_code.length === 0
        || totp.secret.length === 0 || totp.uri.length === 0) {
        throwNas('AUTH_FAILED');
      }
      /* Enrollment material is returned to the caller for the immediate QR
         step, but is never handed to storage or retained in controller state. */
      return detached({
        factorId: data.id,
        qrCode: totp.qr_code,
        secret: totp.secret,
        uri: totp.uri
      });
    }

    async function challengeAndVerify(factorId, code) {
      assertWriteAllowed();
      validateRecordId(factorId);
      if (typeof code !== 'string' || !/^\d{6,8}$/.test(code) || code.length > MAX_TOTP_CODE) {
        throwNas('AUTH_INPUT');
      }
      if (!auth.mfa || typeof auth.mfa.challengeAndVerify !== 'function') {
        throwNas('AUTH_UNAVAILABLE');
      }
      try {
        normaliseAuthData(await auth.mfa.challengeAndVerify({
          factorId: factorId,
          code: code
        }));
      } catch (error) {
        if (error && error.code && String(error.code).indexOf('PORTFOLIO_NAS_') === 0) throw error;
        throwNas('AUTH_FAILED');
      }
      ownerVerified = false;
      offlineStageReady = false;
      return true;
    }

    async function signOut() {
      assertWriteAllowed();
      var userId = lastUserId;
      var activeFlush = flushPromise;
      var authFailure = null;
      var flushSettled = !activeFlush;
      var flushTimedOut = false;
      if (activeFlush && typeof activeFlush.catch === 'function') {
        activeFlush.catch(function () {});
      }
      /* A sign-out request never cancels an active flush before it has had a
         bounded chance to finish.  This avoids clearing a queue while the
         remote operation is still in flight.  The deadline is the escape
         hatch for a hung RPC, after which lifecycle cancellation prevents any
         late result from rewriting protected state. */
      if (activeFlush) {
        try {
          await withTimeout(activeFlush, signOutFlushTimeoutMs, 'SIGNOUT_FLUSH_TIMEOUT');
          flushSettled = true;
        } catch (error) {
          flushTimedOut = !!(error && error.code === 'PORTFOLIO_NAS_SIGNOUT_FLUSH_TIMEOUT');
          if (!flushTimedOut) flushSettled = true;
        }
      }
      signingOut = true;
      signedOut = true;
      lifecycleGeneration += 1;
      try {
        if (!auth || typeof auth.signOut !== 'function') throwNas('AUTH_UNAVAILABLE');
        var result = await withTimeout(
          Promise.resolve().then(function () { return auth.signOut({ scope: 'local' }); }),
          signOutFlushTimeoutMs,
          'SIGNOUT_TIMEOUT'
        );
        normaliseAuthData(result);
      } catch (error) {
        authFailure = error && error.code && String(error.code).indexOf('PORTFOLIO_NAS_') === 0
          ? error : nasError('SIGNOUT_FAILED');
      } finally {
        /* Let protected writes settle before removing cache bytes. Queue and
           recovery are always retained. A timed-out flush keeps records and
           cursor too, because its underlying RPC may still be unwinding. */
        try { await withTimeout(waitForDurability(), signOutFlushTimeoutMs, 'SIGNOUT_DURABILITY_TIMEOUT'); }
        catch (_) { flushTimedOut = true; }
        if (userId && flushSettled && !flushTimedOut) {
          try { await clearCacheKeys(userId); } catch (_) {}
        }
        lastUserId = null;
        baseline = null;
        baselineRows = null;
        cursor = 0;
        queueState = null;
        ownerVerified = false;
        offlineStageReady = false;
        ownerBoundary = null;
      }
      if (authFailure) throw authFailure;
      return true;
    }

    function getStatus() {
      var operationCount = queueState && Array.isArray(queueState.operations)
        ? queueState.operations.length : 0;
      var baselineCount = baseline ? Object.keys(baseline).length : 0;
      return cloneAndFreeze({
        authenticated: !!lastUserId,
        userId: lastUserId,
        ownerVerified: ownerVerified,
        cursor: cursor,
        baselineCount: baselineCount,
        queuedCount: operationCount,
        generation: queueState ? queueState.generation : 0,
        boundary: ownerBoundary
      });
    }

    var api = {
      signInWithPassword: signInWithPassword,
      getAssurance: getAssurance,
      listTotpFactors: listTotpFactors,
      enrolTotp: enrolTotp,
      challengeAndVerify: challengeAndVerify,
      signOut: signOut,
      hydrate: hydrate,
      cached: cached,
      pending: pending,
      rebasePending: rebasePending,
      discardPending: discardPending,
      listRecovery: listRecovery,
      restoreRecovery: restoreRecovery,
      stage: stage,
      flush: flush,
      stashRecovery: stashRecovery,
      getStatus: getStatus,
      status: getStatus,
      constants: {
        pageSize: PAGE_SIZE,
        maxRecords: MAX_RECORDS,
        maxQueue: MAX_QUEUE,
        maxRecovery: MAX_RECOVERY,
        maxPayloadBytes: MAX_PAYLOAD_BYTES
      }
    };
    return Object.freeze(api);
  }

  return Object.freeze({
    createController: createController,
    PAGE_SIZE: PAGE_SIZE,
    MAX_RECORDS: MAX_RECORDS,
    MAX_QUEUE: MAX_QUEUE,
    MAX_RECOVERY: MAX_RECOVERY,
    MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES
  });
}));
