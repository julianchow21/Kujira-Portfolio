/*
 * Kujira Portfolio legacy blob migration.
 *
 * This module deliberately has no dependency on the browser or on Node.  It
 * validates a parsed legacy value, makes a detached normalised plan, and
 * hashes that plan with the small synchronous implementation below.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.KjrMigration = factory();
  }
}(typeof self === 'object' ? self
  : (typeof globalThis === 'object' ? globalThis : this), function () {
  'use strict';

  var ARRAY_COLLECTIONS = [
    'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate', 'cash',
    'cashTxns', 'cpfHistory', 'income', 'expenses', 'snapshots', 'trash',
    'insurance', 'insuranceRiders'
  ];
  var SINGLETON_COLLECTIONS = [
    'cpfBalances', 'categories', 'settings', '_meta'
  ];
  var COLLECTIONS = ARRAY_COLLECTIONS.concat(SINGLETON_COLLECTIONS);
  var SYNC_METADATA_KEYS = [
    'schema', 'version', 'schemaVersion', 'appVersion', 'updatedAt',
    'lastSeenRemoteAt', '_savedAt'
  ];
  var COLLECTION_LOOKUP = Object.create(null);
  var SYNC_METADATA_LOOKUP = Object.create(null);
  var ARRAY_LOOKUP = Object.create(null);
  var SINGLETON_LOOKUP = Object.create(null);
  var DANGEROUS_KEYS = Object.create(null);
  DANGEROUS_KEYS['__proto__'] = true;
  DANGEROUS_KEYS.prototype = true;
  DANGEROUS_KEYS.constructor = true;
  var APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var HAS_OWN = Object.prototype.hasOwnProperty;

  ARRAY_COLLECTIONS.forEach(function (name) { ARRAY_LOOKUP[name] = true; });
  SINGLETON_COLLECTIONS.forEach(function (name) { SINGLETON_LOOKUP[name] = true; });
  COLLECTIONS.forEach(function (name) { COLLECTION_LOOKUP[name] = true; });
  SYNC_METADATA_KEYS.forEach(function (name) { SYNC_METADATA_LOOKUP[name] = true; });

  function hasOwn(value, key) {
    return HAS_OWN.call(value, key);
  }

  function fail(code, path) {
    var error = new Error('PORTFOLIO_IMPORT_' + code + (path ? ': ' + path : ''));
    error.code = 'PORTFOLIO_IMPORT_' + code;
    throw error;
  }

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  function isPlainObject(value) {
    if (!isObject(value) || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    /* The second form also accepts an Object.prototype from another realm,
       which is normal when a host embeds this script in a worker or iframe. */
    return proto === null || Object.getPrototypeOf(proto) === null;
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && value === value
      && value !== Infinity && value !== -Infinity;
  }

  function checkSymbols(value, path) {
    if (typeof Object.getOwnPropertySymbols !== 'function') return;
    if (Object.getOwnPropertySymbols(value).length) fail('SYMBOL_KEY', path);
  }

  function checkPropertyDescriptor(value, key, descriptor, path, isArrayLength) {
    if (!descriptor) fail('MALFORMED_PROPERTY', path + '.' + key);
    if (descriptor.get || descriptor.set) fail('ACCESSOR', path + '.' + key);
    if (!descriptor.enumerable && !isArrayLength) {
      fail('NON_ENUMERABLE_KEY', path + '.' + key);
    }
  }

  function checkDangerousKey(key, path) {
    if (DANGEROUS_KEYS[key]) fail('DANGEROUS_KEY', path + '.' + key);
  }

  /* Check the object shape before reading any values.  This keeps getters,
     symbol properties and non-JSON properties from becoming silent loss. */
  function checkObjectShape(value, path) {
    if (!isPlainObject(value)) fail('NON_PLAIN_OBJECT', path);
    checkSymbols(value, path);
    Object.getOwnPropertyNames(value).forEach(function (key) {
      checkDangerousKey(key, path);
      checkPropertyDescriptor(value, key,
        Object.getOwnPropertyDescriptor(value, key), path, false);
    });
  }

  function checkArrayShape(value, path) {
    if (!Array.isArray(value)) fail('WRONG_COLLECTION_TYPE', path);
    checkSymbols(value, path);
    Object.getOwnPropertyNames(value).forEach(function (key) {
      var isLength = key === 'length';
      checkPropertyDescriptor(value, key,
        Object.getOwnPropertyDescriptor(value, key), path, isLength);
      if (isLength) return;
      if (!/^\d+$/.test(key)) fail('UNEXPECTED_KEY', path + '.' + key);
      var index = Number(key);
      if (String(index) !== key || index < 0 || index >= value.length) {
        fail('UNEXPECTED_KEY', path + '.' + key);
      }
    });
    for (var i = 0; i < value.length; i++) {
      if (!hasOwn(value, String(i))) fail('SPARSE_ARRAY', path + '[' + i + ']');
    }
  }

  function defineData(target, key, value) {
    Object.defineProperty(target, key, {
      value: value,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }

  /* Clone and validate in one pass.  `stack` is the current recursion path,
     so shared (but acyclic) values are accepted and detached independently. */
  function cloneValue(value, path, stack) {
    if (value === null) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!isFiniteNumber(value)) fail('NONFINITE_NUMBER', path);
      return value;
    }
    if (typeof value !== 'object') fail('UNSUPPORTED_VALUE', path);

    if (stack.indexOf(value) !== -1) fail('CYCLE', path);
    stack.push(value);

    var copy;
    if (Array.isArray(value)) {
      checkArrayShape(value, path);
      copy = new Array(value.length);
      for (var i = 0; i < value.length; i++) {
        copy[i] = cloneValue(value[i], path + '[' + i + ']', stack);
      }
    } else {
      checkObjectShape(value, path);
      copy = {};
      Object.getOwnPropertyNames(value).forEach(function (key) {
        defineData(copy, key, cloneValue(value[key], path + '.' + key, stack));
      });
    }

    stack.pop();
    return copy;
  }

  function canonicalNumber(value, path) {
    if (!isFiniteNumber(value)) fail('NONFINITE_NUMBER', path);
    var encoded = JSON.stringify(value);
    if (encoded === undefined) fail('UNSUPPORTED_VALUE', path);
    return encoded;
  }

  function canonicalJson(value, path, stack) {
    path = path || '$';
    stack = stack || [];
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'boolean') {
      return JSON.stringify(value);
    }
    if (typeof value === 'number') return canonicalNumber(value, path);
    if (typeof value !== 'object') fail('UNSUPPORTED_VALUE', path);
    if (stack.indexOf(value) !== -1) fail('CYCLE', path);
    stack.push(value);

    var output;
    if (Array.isArray(value)) {
      checkArrayShape(value, path);
      var items = [];
      for (var i = 0; i < value.length; i++) {
        items.push(canonicalJson(value[i], path + '[' + i + ']', stack));
      }
      output = '[' + items.join(',') + ']';
    } else {
      checkObjectShape(value, path);
      var keys = Object.getOwnPropertyNames(value).sort();
      var pairs = [];
      keys.forEach(function (key) {
        pairs.push(JSON.stringify(key) + ':'
          + canonicalJson(value[key], path + '.' + key, stack));
      });
      output = '{' + pairs.join(',') + '}';
    }

    stack.pop();
    return output;
  }

  function utf8Bytes(value) {
    var bytes = [];
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        var next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
        if (next >= 0xDC00 && next <= 0xDFFF) {
          code = 0x10000 + ((code - 0xD800) << 10) + (next - 0xDC00);
          i++;
        } else {
          code = 0xFFFD;
        }
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        code = 0xFFFD;
      }

      if (code <= 0x7F) {
        bytes.push(code);
      } else if (code <= 0x7FF) {
        bytes.push(0xC0 | (code >>> 6), 0x80 | (code & 0x3F));
      } else if (code <= 0xFFFF) {
        bytes.push(0xE0 | (code >>> 12),
          0x80 | ((code >>> 6) & 0x3F), 0x80 | (code & 0x3F));
      } else {
        bytes.push(0xF0 | (code >>> 18),
          0x80 | ((code >>> 12) & 0x3F),
          0x80 | ((code >>> 6) & 0x3F), 0x80 | (code & 0x3F));
      }
    }
    return bytes;
  }

  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }

  /* SHA-256, kept synchronous so the exact same hash works in a plain script
     tag and under Node without Web Crypto or the Node `crypto` module. */
  function sha256(value) {
    var bytes = utf8Bytes(value);
    var bitLengthLow = (bytes.length * 8) >>> 0;
    var bitLengthHigh = Math.floor(bytes.length / 0x20000000) >>> 0;
    var totalLength = Math.ceil((bytes.length + 9) / 64) * 64;
    var padded = new Array(totalLength);
    for (var p = 0; p < totalLength; p++) padded[p] = 0;
    for (var b = 0; b < bytes.length; b++) padded[b] = bytes[b];
    padded[bytes.length] = 0x80;
    for (var j = 0; j < 4; j++) {
      padded[totalLength - 1 - j] = (bitLengthLow >>> (j * 8)) & 0xFF;
      padded[totalLength - 5 - j] = (bitLengthHigh >>> (j * 8)) & 0xFF;
    }

    var constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
      0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
      0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
      0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
      0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
      0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    var hash = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];

    for (var offset = 0; offset < totalLength; offset += 64) {
      var words = new Array(64);
      for (var wi = 0; wi < 16; wi++) {
        var at = offset + wi * 4;
        words[wi] = ((padded[at] << 24) | (padded[at + 1] << 16)
          | (padded[at + 2] << 8) | padded[at + 3]) >>> 0;
      }
      for (var wj = 16; wj < 64; wj++) {
        var s0 = (rightRotate(words[wj - 15], 7)
          ^ rightRotate(words[wj - 15], 18)
          ^ (words[wj - 15] >>> 3)) >>> 0;
        var s1 = (rightRotate(words[wj - 2], 17)
          ^ rightRotate(words[wj - 2], 19)
          ^ (words[wj - 2] >>> 10)) >>> 0;
        words[wj] = (words[wj - 16] + s0 + words[wj - 7] + s1) >>> 0;
      }

      var a = hash[0], bb = hash[1], c = hash[2], d = hash[3];
      var e = hash[4], f = hash[5], g = hash[6], h = hash[7];
      for (var round = 0; round < 64; round++) {
        var bigS1 = (rightRotate(e, 6) ^ rightRotate(e, 11)
          ^ rightRotate(e, 25)) >>> 0;
        var choose = ((e & f) ^ ((~e) & g)) >>> 0;
        var temp1 = (h + bigS1 + choose + constants[round]
          + words[round]) >>> 0;
        var bigS0 = (rightRotate(a, 2) ^ rightRotate(a, 13)
          ^ rightRotate(a, 22)) >>> 0;
        var majority = ((a & bb) ^ (a & c) ^ (bb & c)) >>> 0;
        var temp2 = (bigS0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = bb;
        bb = a;
        a = (temp1 + temp2) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0;
      hash[1] = (hash[1] + bb) >>> 0;
      hash[2] = (hash[2] + c) >>> 0;
      hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0;
      hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0;
      hash[7] = (hash[7] + h) >>> 0;
    }

    return hash.map(function (word) {
      return ('00000000' + word.toString(16)).slice(-8);
    }).join('');
  }

  function topLevelShape(input) {
    if (!isPlainObject(input)) fail('ROOT', '$');
    checkSymbols(input, '$');
    var names = Object.getOwnPropertyNames(input);
    names.forEach(function (name) {
      checkDangerousKey(name, '$');
      checkPropertyDescriptor(input, name,
        Object.getOwnPropertyDescriptor(input, name), '$', false);
      if (name !== '_priceCache' && !COLLECTION_LOOKUP[name]
        && !SYNC_METADATA_LOOKUP[name]) {
        fail('UNEXPECTED_KEY', '$.' + name);
      }
    });
    COLLECTIONS.forEach(function (name) {
      if (!hasOwn(input, name)) fail('MISSING_COLLECTION', '$.' + name);
    });
    if (hasOwn(input, '_priceCache') && !isPlainObject(input._priceCache)) {
      fail('WRONG_COLLECTION_TYPE', '$._priceCache');
    }
    ARRAY_COLLECTIONS.forEach(function (name) {
      if (!Array.isArray(input[name])) fail('WRONG_COLLECTION_TYPE', '$.' + name);
    });
    SINGLETON_COLLECTIONS.forEach(function (name) {
      if (!isPlainObject(input[name])) fail('WRONG_COLLECTION_TYPE', '$.' + name);
    });
  }

  function incrementOccurrence(entries, key) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].key === key) {
        var old = entries[i].count;
        entries[i].count++;
        return old;
      }
    }
    entries.push({ key: key, count: 1 });
    return 0;
  }

  function hasId(ids, id) {
    return ids.indexOf(id) !== -1;
  }

  function generatedRecordId(recordType, payload, occurrence) {
    var identity = {
      recordType: recordType,
      payload: payload,
      occurrence: occurrence
    };
    return 'legacy-' + sha256(canonicalJson(identity)).slice(0, 57);
  }

  function arrayRecordId(recordType, payload, occurrences) {
    var payloadCanonical = canonicalJson(payload, '$.' + recordType + '.payload');
    var occurrence = incrementOccurrence(occurrences, payloadCanonical);
    if (hasOwn(payload, 'id')) {
      if (typeof payload.id !== 'string') fail('INVALID_ID', recordType + '.id');
      if (payload.id !== '' && !APP_ID_RE.test(payload.id)) {
        fail('INVALID_ID', recordType + '.id');
      }
      if (payload.id !== '') return { recordId: payload.id, generated: false };
    }
    return {
      recordId: generatedRecordId(recordType, payload, occurrence),
      generated: true
    };
  }

  function buildRecords(source) {
    var records = [];
    var idsByCollection = Object.create(null);
    COLLECTIONS.forEach(function (name) { idsByCollection[name] = []; });

    ARRAY_COLLECTIONS.forEach(function (name) {
      var occurrences = [];
      source[name].forEach(function (payload, index) {
        if (!isPlainObject(payload)) fail('RECORD_TYPE', name + '[' + index + ']');
        var identity = arrayRecordId(name, payload, occurrences);
        var recordId = identity.recordId;
        if (hasId(idsByCollection[name], recordId)) {
          fail('DUPLICATE_ID', name + '.id');
        }
        idsByCollection[name].push(recordId);
        var outputPayload = payload;
        if (identity.generated) {
          outputPayload = cloneValue(payload, '$.' + name + '[' + index + ']', []);
          defineData(outputPayload, 'id', recordId);
        }
        records.push({
          recordType: name,
          recordId: recordId,
          payload: outputPayload,
          position: index
        });
      });
    });

    SINGLETON_COLLECTIONS.forEach(function (name) {
      var payload = source[name];
      records.push({
        recordType: name,
        recordId: 'singleton',
        payload: payload,
        position: 0
      });
      idsByCollection[name].push('singleton');
    });

    var syncMeta = {};
    var hasSyncMetadata = false;
    SYNC_METADATA_KEYS.forEach(function (name) {
      if (hasOwn(source, name)) {
        hasSyncMetadata = true;
        defineData(syncMeta, name, source[name]);
      }
    });
    if (hasSyncMetadata) {
      records.push({
        recordType: '_syncMeta',
        recordId: 'singleton',
        payload: syncMeta,
        position: 0
      });
    }

    records.sort(function (left, right) {
      if (left.recordType < right.recordType) return -1;
      if (left.recordType > right.recordType) return 1;
      if (left.recordId < right.recordId) return -1;
      if (left.recordId > right.recordId) return 1;
      return 0;
    });
    return { records: records, idsByCollection: idsByCollection };
  }

  function checkLink(payload, field, targetIds, path, required, relationshipState) {
    if (!hasOwn(payload, field)) {
      if (required) fail('DANGLING_LINK_' + path, path);
      return;
    }
    var value = payload[field];
    relationshipState.checked++;
    if (typeof value !== 'string' || value === ''
      || value.trim() !== value || !APP_ID_RE.test(value)) {
      fail('INVALID_RELATIONSHIP_ID', path);
    }
    if (!hasId(targetIds, value)) fail('DANGLING_LINK_' + path, path);
  }

  function validateRelationships(records, idsByCollection) {
    var state = { checked: 0, valid: true };
    records.forEach(function (record) {
      var payload = record.payload;
      if (record.recordType === 'stockTxns') {
        checkLink(payload, 'stockId', idsByCollection.stocks,
          'stockTxns.stockId', true, state);
        checkLink(payload, 'cashAccountId', idsByCollection.cash,
          'stockTxns.cashAccountId', false, state);
      } else if (record.recordType === 'cashTxns') {
        checkLink(payload, 'cashAccountId', idsByCollection.cash,
          'cashTxns.cashAccountId', true, state);
        checkLink(payload, 'fromAccountId', idsByCollection.cash,
          'cashTxns.fromAccountId', false, state);
      } else if (record.recordType === 'insuranceRiders') {
        checkLink(payload, 'policyId', idsByCollection.insurance,
          'insuranceRiders.policyId', true, state);
      }
    });
    return state;
  }

  function buildCounts(source, records) {
    var counts = {};
    COLLECTIONS.forEach(function (name) {
      var outputCount = 0;
      records.forEach(function (record) {
        if (record.recordType === name) outputCount++;
      });
      counts[name] = {
        source: ARRAY_LOOKUP[name] ? source[name].length : 1,
        output: outputCount
      };
    });
    var syncMetaOutput = 0;
    records.forEach(function (record) {
      if (record.recordType === '_syncMeta') syncMetaOutput++;
    });
    if (syncMetaOutput) {
      counts._syncMeta = { source: 1, output: syncMetaOutput };
    }
    return counts;
  }

  function freezeDeep(value, seen) {
    if (!isObject(value)) return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) return value;
    seen.push(value);
    Object.getOwnPropertyNames(value).forEach(function (key) {
      freezeDeep(value[key], seen);
    });
    Object.freeze(value);
    return value;
  }

  function planLegacyImport(input) {
    topLevelShape(input);

    /* Clone the accepted source first.  `_priceCache` is walked and checked,
       then deliberately discarded before sourceHash is calculated. */
    var source = {};
    COLLECTIONS.forEach(function (name) {
      defineData(source, name, cloneValue(input[name], '$.' + name, []));
    });
    SYNC_METADATA_KEYS.forEach(function (name) {
      if (hasOwn(input, name)) {
        defineData(source, name, cloneValue(input[name], '$.' + name, []));
      }
    });
    if (hasOwn(input, '_priceCache')) {
      cloneValue(input._priceCache, '$._priceCache', []);
    }

    var sourceHash = sha256(canonicalJson(source));
    var built = buildRecords(source);
    var relationships = validateRelationships(built.records, built.idsByCollection);
    var counts = buildCounts(source, built.records);
    var result = {
      formatVersion: 1,
      records: built.records,
      counts: counts,
      relationships: relationships,
      sourceHash: sourceHash,
      recordsHash: sha256(canonicalJson(built.records))
    };
    return freezeDeep(result);
  }

  return Object.freeze({
    planLegacyImport: planLegacyImport
  });
}));
