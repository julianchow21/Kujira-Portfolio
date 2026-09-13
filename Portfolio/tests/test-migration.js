'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const migration = require('../Worker/kjr-migration.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'migration');
const COLLECTIONS = [
  'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate', 'cash',
  'cashTxns', 'cpfHistory', 'income', 'expenses', 'snapshots', 'trash',
  'insurance', 'insuranceRiders', 'cpfBalances', 'categories', 'settings',
  '_meta'
];
const ARRAY_COLLECTIONS = [
  'stocks', 'stockTxns', 'watchlist', 'crypto', 'realestate', 'cash',
  'cashTxns', 'cpfHistory', 'income', 'expenses', 'snapshots', 'trash',
  'insurance', 'insuranceRiders'
];
const SYNC_METADATA_KEYS = [
  'schema', 'version', 'schemaVersion', 'appVersion', 'updatedAt',
  'lastSeenRemoteAt', '_savedAt'
];
const COUNT_KEYS = COLLECTIONS.concat('_syncMeta');

const EXPECTED_SOURCE_HASH =
  'c9766b3310e7e41b65d78c91d2703998e9f01fdc2df0d5230026605d32b9b943';
const EXPECTED_RECORDS_HASH =
  '1ac80a870de522baeb805d7ac99cfc3f68115121ea384750a1b3b39a843a1ed9';

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function validFixture() {
  return loadFixture('Valid.json');
}

function canonicalTest(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalTest).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalTest(value[key])}`
  )).join(',')}}`;
}

function sha256Test(canonical) {
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function expectedRecordsForFixture(input) {
  const records = [];
  COLLECTIONS.forEach((name) => {
    if (Array.isArray(input[name])) {
      const occurrences = new Map();
      input[name].forEach((payload, position) => {
        const payloadCanonical = canonicalTest(payload);
        const occurrence = occurrences.get(payloadCanonical) || 0;
        occurrences.set(payloadCanonical, occurrence + 1);
        const recordId = payload.id === undefined || payload.id === ''
          ? `legacy-${sha256Test(canonicalTest({
            recordType: name,
            payload,
            occurrence
          })).slice(0, 57)}`
          : payload.id;
        const outputPayload = JSON.parse(JSON.stringify(payload));
        if (payload.id === undefined || payload.id === '') outputPayload.id = recordId;
        records.push({
          recordType: name,
          recordId,
          payload: outputPayload,
          position
        });
      });
    } else {
      records.push({
        recordType: name,
        recordId: 'singleton',
        payload: JSON.parse(JSON.stringify(input[name])),
        position: 0
      });
    }
  });
  const syncMeta = {};
  SYNC_METADATA_KEYS.forEach((name) => {
    if (Object.prototype.hasOwnProperty.call(input, name)) syncMeta[name] = input[name];
  });
  if (Object.keys(syncMeta).length) {
    records.push({
      recordType: '_syncMeta',
      recordId: 'singleton',
      payload: JSON.parse(JSON.stringify(syncMeta)),
      position: 0
    });
  }
  records.sort((left, right) => (
    left.recordType < right.recordType ? -1
      : left.recordType > right.recordType ? 1
        : left.recordId < right.recordId ? -1
          : left.recordId > right.recordId ? 1 : 0
  ));
  return records;
}

function blankFixture() {
  const input = validFixture();
  COLLECTIONS.forEach((name) => {
    input[name] = Array.isArray(input[name]) ? [] : {};
  });
  SYNC_METADATA_KEYS.forEach((name) => { delete input[name]; });
  delete input._priceCache;
  return input;
}

function reorderObjects(value) {
  if (Array.isArray(value)) return value.map(reorderObjects);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).reverse().reduce((copy, key) => {
    copy[key] = reorderObjects(value[key]);
    return copy;
  }, {});
}

function assertImportError(label, input, expectedPrefix) {
  assert.throws(
    () => migration.planLegacyImport(input),
    (error) => {
      assert(error instanceof Error, `${label} did not throw an Error`);
      assert(
        error.message.startsWith(expectedPrefix || 'PORTFOLIO_IMPORT_'),
        `${label} error prefix was ${error.message}`
      );
      return true;
    },
    `${label} should reject`
  );
}

function recordFor(plan, type, predicate) {
  return plan.records.find((record) => record.recordType === type && predicate(record));
}

function run() {
  let passed = 0;
  const test = (name, fn) => {
    fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  };

  test('valid fixture normalises all collections and validates all links', () => {
    const input = validFixture();
    const before = JSON.stringify(input);
    const plan = migration.planLegacyImport(input);

    assert.strictEqual(plan.formatVersion, 1);
    assert.strictEqual(plan.records.length, 19);
    assert.deepStrictEqual(Object.keys(plan.counts).sort(), COUNT_KEYS.slice().sort());
    COLLECTIONS.forEach((name) => {
      assert.deepStrictEqual(plan.counts[name], { source: 1, output: 1 });
    });
    assert.deepStrictEqual(plan.counts._syncMeta, { source: 1, output: 1 });
    assert.deepStrictEqual(plan.relationships, { checked: 5, valid: true });
    assert.strictEqual(plan.sourceHash, EXPECTED_SOURCE_HASH);
    assert.strictEqual(plan.recordsHash, EXPECTED_RECORDS_HASH);

    const sourceForHash = JSON.parse(JSON.stringify(input));
    delete sourceForHash._priceCache;
    assert.strictEqual(plan.sourceHash, sha256Test(canonicalTest(sourceForHash)));
    const recordsForHash = expectedRecordsForFixture(input);
    assert.deepStrictEqual(plan.records, recordsForHash);
    assert.strictEqual(plan.recordsHash, sha256Test(canonicalTest(recordsForHash)));

    plan.records.forEach((record) => {
      assert.strictEqual(record.position, 0);
      if (ARRAY_COLLECTIONS.includes(record.recordType)) {
        assert.strictEqual(record.payload.id, record.recordId);
        assert.match(record.recordId, /^[A-Za-z0-9_-]{1,64}$/);
      } else {
        assert.strictEqual(record.recordId, 'singleton');
      }
    });

    for (let i = 1; i < plan.records.length; i += 1) {
      const previous = plan.records[i - 1];
      const current = plan.records[i];
      assert(
        previous.recordType < current.recordType
          || (previous.recordType === current.recordType
            && previous.recordId <= current.recordId),
        'records must be sorted by recordType then recordId'
      );
    }
    assert.strictEqual(JSON.stringify(input), before, 'input must not be mutated');
    assert.strictEqual(recordFor(plan, 'settings', () => true).payload.emptyValue, '');
    assert.strictEqual(recordFor(plan, 'stocks', () => true).payload.shares, 10);
    assert.strictEqual(
      recordFor(plan, 'insuranceRiders', () => true).payload.policyId,
      'policy-a'
    );
    assert.strictEqual(
      recordFor(plan, 'stockTxns', () => true).payload.stockId,
      'stock-a'
    );
    assert.strictEqual(
      recordFor(plan, 'stockTxns', () => true).payload.cashAccountId,
      'cash-main'
    );
    assert.strictEqual(
      recordFor(plan, 'cashTxns', () => true).payload.cashAccountId,
      'cash-main'
    );
    assert.strictEqual(
      recordFor(plan, 'cashTxns', () => true).payload.fromAccountId,
      'cash-main'
    );
    const syncMeta = recordFor(plan, '_syncMeta', () => true);
    assert(syncMeta, 'metadata record should be present when metadata keys are present');
    assert.deepStrictEqual(Object.keys(syncMeta.payload).sort(), SYNC_METADATA_KEYS.slice().sort());
    SYNC_METADATA_KEYS.forEach((name) => {
      assert.deepStrictEqual(syncMeta.payload[name], input[name]);
    });
    assert.strictEqual(syncMeta.position, 0);
    assert.strictEqual(
      plan.records.some((record) => Object.prototype.hasOwnProperty.call(record.payload, '_priceCache')),
      false,
      'the excluded cache must not be copied into payloads'
    );
  });

  test('hashes ignore _priceCache and object-key order', () => {
    const withCache = validFixture();
    const withoutCache = validFixture();
    delete withoutCache._priceCache;
    const reordered = reorderObjects(withCache);
    const first = migration.planLegacyImport(withCache);
    const second = migration.planLegacyImport(withoutCache);
    const third = migration.planLegacyImport(reordered);
    assert.strictEqual(first.sourceHash, second.sourceHash);
    assert.strictEqual(first.recordsHash, second.recordsHash);
    assert.strictEqual(first.sourceHash, third.sourceHash);
    assert.strictEqual(first.recordsHash, third.recordsHash);
  });

  test('does not invent an optional sync metadata record', () => {
    const plan = migration.planLegacyImport(blankFixture());
    assert.strictEqual(plan.records.some((record) => record.recordType === '_syncMeta'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(plan.counts, '_syncMeta'), false);
  });

  test('rejects whitespace-normalisation and preserves exact valid IDs', () => {
    const input = validFixture();
    input.watchlist[0].id = '  watch-a  ';
    assertImportError('whitespace ID', input, 'PORTFOLIO_IMPORT_INVALID_ID');
    const valid = validFixture();
    const plan = migration.planLegacyImport(valid);
    const watch = recordFor(plan, 'watchlist', () => true);
    assert.strictEqual(watch.recordId, 'watch-a');
    assert.strictEqual(watch.payload.id, 'watch-a');
  });

  test('retains source array order through the position field and hash', () => {
    const orderedInput = validFixture();
    orderedInput.stocks.push({ id: 'stock-b', ticker: 'SYN2', shares: 4 });
    const reorderedInput = validFixture();
    reorderedInput.stocks.push({ id: 'stock-b', ticker: 'SYN2', shares: 4 });
    reorderedInput.stocks.unshift(reorderedInput.stocks.pop());
    const ordered = migration.planLegacyImport(orderedInput);
    const reordered = migration.planLegacyImport(reorderedInput);
    assert.strictEqual(
      recordFor(ordered, 'stocks', (record) => record.recordId === 'stock-a').position,
      0
    );
    assert.strictEqual(
      recordFor(ordered, 'stocks', (record) => record.recordId === 'stock-b').position,
      1
    );
    assert.strictEqual(
      recordFor(reordered, 'stocks', (record) => record.recordId === 'stock-a').position,
      1
    );
    assert.strictEqual(
      recordFor(reordered, 'stocks', (record) => record.recordId === 'stock-b').position,
      0
    );
    assert.notStrictEqual(ordered.recordsHash, reordered.recordsHash);
  });

  test('generates deterministic IDs with duplicate-payload occurrences', () => {
    const input = blankFixture();
    input.watchlist = [
      { ticker: 'same', empty: '', n: 0 },
      { ticker: 'same', empty: '', n: 0 },
      { ticker: 'other' }
    ];
    const before = JSON.stringify(input);
    const plan = migration.planLegacyImport(input);
    const records = plan.records.filter((record) => record.recordType === 'watchlist');
    const expected = [
      'legacy-0f4f50e4f765d93f51974bec54edabe8c5b0411db1b8b8e68b7d8c556',
      'legacy-e4e5b53a075acadcabc9c8f51ec054da68b942031006e579e6785a649',
      'legacy-fbb6b9e967096be3ab61817383e10698883808d328b14afd77a969755'
    ];
    assert.deepStrictEqual(records.map((record) => record.recordId).sort(), expected.sort());
    assert.strictEqual(new Set(records.map((record) => record.recordId)).size, 3);
    records.forEach((record) => {
      assert.strictEqual(record.recordId.length, 64);
      assert.match(record.recordId, /^legacy-[A-Za-z0-9_-]{57}$/);
      assert.strictEqual(record.payload.id, record.recordId);
    });
    assert.strictEqual(JSON.stringify(input), before, 'generated IDs must not mutate input');
    const repeat = migration.planLegacyImport(reorderObjects(input));
    assert.strictEqual(repeat.recordsHash, plan.recordsHash);
    assert.strictEqual(repeat.sourceHash, plan.sourceHash);
  });

  test('rejects non-string, whitespace, invalid and overlong existing IDs', () => {
    [
      ['whitespace-only', '   '],
      ['leading whitespace', ' watch-a'],
      ['trailing whitespace', 'watch-a '],
      ['invalid character', 'watch/a'],
      ['overlong', 'a'.repeat(65)],
      ['number', 42],
      ['null', null]
    ].forEach(([label, id]) => {
      const input = validFixture();
      input.watchlist[0].id = id;
      assertImportError(label, input, 'PORTFOLIO_IMPORT_INVALID_ID');
    });
  });

  test('returns detached, deeply frozen output', () => {
    const input = validFixture();
    const plan = migration.planLegacyImport(input);
    input.stocks[0].ticker = 'changed after planning';
    assert.strictEqual(recordFor(plan, 'stocks', () => true).payload.ticker, 'SYN');
    assert.strictEqual(Object.isFrozen(plan), true);
    assert.strictEqual(Object.isFrozen(plan.records), true);
    assert.strictEqual(Object.isFrozen(plan.records[0]), true);
    assert.strictEqual(Object.isFrozen(plan.records[0].payload), true);
    assert.throws(() => { plan.records[0].recordId = 'changed'; }, TypeError);
    assert.throws(() => { plan.records[0].payload.extra = true; }, TypeError);
    assert.throws(() => { plan.counts.stocks.output = 0; }, TypeError);
  });

  test('rejects each relationship class with a stable dangling-link prefix', () => {
    [
      ['stockTxns', 'stockId'],
      ['stockTxns', 'cashAccountId'],
      ['cashTxns', 'cashAccountId'],
      ['cashTxns', 'fromAccountId'],
      ['insuranceRiders', 'policyId']
    ].forEach(([collection, field]) => {
      const input = validFixture();
      input[collection][0][field] = 'missing-link';
      assertImportError(
        `${collection}.${field}`,
        input,
        'PORTFOLIO_IMPORT_DANGLING_LINK'
      );
    });
    const numericOptional = validFixture();
    numericOptional.stockTxns[0].cashAccountId = 0;
    assertImportError(
      'numeric optional stock cash link',
      numericOptional,
      'PORTFOLIO_IMPORT_INVALID_RELATIONSHIP_ID'
    );
    [
      ['stockTxns', 'stockId', ' stock-a '],
      ['stockTxns', 'cashAccountId', ' cash-main '],
      ['cashTxns', 'cashAccountId', ' cash-main '],
      ['cashTxns', 'fromAccountId', ' cash-main '],
      ['insuranceRiders', 'policyId', ' policy-a ']
    ].forEach(([collection, field, padded]) => {
      const input = validFixture();
      input[collection][0][field] = padded;
      assertImportError(
        `${collection}.${field} padded value`,
        input,
        'PORTFOLIO_IMPORT_INVALID_RELATIONSHIP_ID'
      );
    });
    [
      ['stockTxns', 'stockId', 'stock-a'],
      ['stockTxns', 'cashAccountId', 'cash-main'],
      ['cashTxns', 'cashAccountId', 'cash-main'],
      ['cashTxns', 'fromAccountId', 'cash-main'],
      ['insuranceRiders', 'policyId', 'policy-a']
    ].forEach(([collection, field]) => {
      ['', 'bad/id', 42].forEach((invalid) => {
        const input = validFixture();
        input[collection][0][field] = invalid;
        assertImportError(
          `${collection}.${field} invalid value`,
          input,
          'PORTFOLIO_IMPORT_INVALID_RELATIONSHIP_ID'
        );
      });
      const exact = validFixture();
      delete exact[collection][0][field];
      if (collection === 'stockTxns' && field === 'stockId') {
        assertImportError(
          `${collection}.${field} missing value`,
          exact,
          'PORTFOLIO_IMPORT_DANGLING_LINK'
        );
      } else if (collection === 'cashTxns' && field === 'cashAccountId') {
        assertImportError(
          `${collection}.${field} missing value`,
          exact,
          'PORTFOLIO_IMPORT_DANGLING_LINK'
        );
      } else if (collection === 'insuranceRiders' && field === 'policyId') {
        assertImportError(
          `${collection}.${field} missing value`,
          exact,
          'PORTFOLIO_IMPORT_DANGLING_LINK'
        );
      } else {
        const plan = migration.planLegacyImport(exact);
        assert(plan.relationships.valid);
      }
    });
  });

  test('rejects fixture-level invalid input', () => {
    assertImportError(
      'dangling fixture',
      loadFixture('Dangling Link.json'),
      'PORTFOLIO_IMPORT_DANGLING_LINK'
    );
    assertImportError(
      'duplicate fixture',
      loadFixture('Duplicate ID.json'),
      'PORTFOLIO_IMPORT_DUPLICATE_ID'
    );
    assertImportError(
      'unexpected fixture',
      loadFixture('Unexpected Key.json'),
      'PORTFOLIO_IMPORT_UNEXPECTED_KEY'
    );
    assertImportError(
      'dangerous fixture',
      loadFixture('Dangerous Key.json'),
      'PORTFOLIO_IMPORT_DANGEROUS_KEY'
    );
  });

  test('rejects malformed roots, collection types and missing collections', () => {
    assertImportError('null root', null);
    assertImportError('array root', []);
    const missing = blankFixture();
    delete missing.cash;
    assertImportError('missing collection', missing, 'PORTFOLIO_IMPORT_MISSING_COLLECTION');
    const wrongArray = blankFixture();
    wrongArray.stocks = {};
    assertImportError('wrong array collection', wrongArray, 'PORTFOLIO_IMPORT_WRONG_COLLECTION_TYPE');
    const wrongSingleton = blankFixture();
    wrongSingleton.settings = [];
    assertImportError('wrong singleton collection', wrongSingleton, 'PORTFOLIO_IMPORT_WRONG_COLLECTION_TYPE');
    const nonPlain = blankFixture();
    nonPlain.settings = new Date(0);
    assertImportError('non-plain singleton', nonPlain, 'PORTFOLIO_IMPORT_WRONG_COLLECTION_TYPE');
  });

  test('rejects unsafe values, sparse arrays, cycles and dangerous keys', () => {
    const undefinedValue = blankFixture();
    undefinedValue.settings.bad = undefined;
    assertImportError('undefined', undefinedValue, 'PORTFOLIO_IMPORT_UNSUPPORTED_VALUE');

    const functionValue = blankFixture();
    functionValue.settings.bad = () => true;
    assertImportError('function', functionValue, 'PORTFOLIO_IMPORT_UNSUPPORTED_VALUE');

    const symbolValue = blankFixture();
    symbolValue.settings.bad = Symbol('bad');
    assertImportError('symbol value', symbolValue, 'PORTFOLIO_IMPORT_UNSUPPORTED_VALUE');

    const nonFinite = blankFixture();
    nonFinite.settings.bad = NaN;
    assertImportError('NaN', nonFinite, 'PORTFOLIO_IMPORT_NONFINITE_NUMBER');
    const infinite = blankFixture();
    infinite.settings.bad = Infinity;
    assertImportError('Infinity', infinite, 'PORTFOLIO_IMPORT_NONFINITE_NUMBER');

    const sparse = blankFixture();
    sparse.watchlist = new Array(1);
    assertImportError('sparse array', sparse, 'PORTFOLIO_IMPORT_SPARSE_ARRAY');

    const cyclic = blankFixture();
    cyclic.settings.self = cyclic.settings;
    assertImportError('cycle', cyclic, 'PORTFOLIO_IMPORT_CYCLE');

    const dangerous = blankFixture();
    dangerous.settings.nested = JSON.parse('{"prototype": true}');
    assertImportError('dangerous key', dangerous, 'PORTFOLIO_IMPORT_DANGEROUS_KEY');

    const symbolKey = blankFixture();
    symbolKey.settings[Symbol('key')] = 'blocked';
    assertImportError('symbol key', symbolKey, 'PORTFOLIO_IMPORT_SYMBOL_KEY');

    const nonEnumerable = blankFixture();
    Object.defineProperty(nonEnumerable.settings, 'hidden', { value: true, enumerable: false });
    assertImportError('non-enumerable key', nonEnumerable, 'PORTFOLIO_IMPORT_NON_ENUMERABLE_KEY');
  });

  test('does not write to console while processing valid or invalid input', () => {
    const original = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info
    };
    let writes = 0;
    console.log = () => { writes += 1; };
    console.error = () => { writes += 1; };
    console.warn = () => { writes += 1; };
    console.info = () => { writes += 1; };
    try {
      migration.planLegacyImport(validFixture());
      assertImportError('captured dangerous fixture', loadFixture('Dangerous Key.json'));
    } finally {
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
      console.info = original.info;
    }
    assert.strictEqual(writes, 0);
  });

  console.log(`Migration tests passed: ${passed}`);
}

run();
