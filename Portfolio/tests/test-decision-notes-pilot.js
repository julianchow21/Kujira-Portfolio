/* Focused contract tests for the loopback-only synthetic decision-notes pilot. */
const assert = require('assert');
const pilot = require('../Worker/decision-notes-pilot.js');

function storage(initial) {
  const data = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    raw(key) { return data.get(key); }
  };
}

function serialLocks() {
  let tail = Promise.resolve();
  return {
    request(_name, _options, callback) {
      const run = tail.then(callback);
      tail = run.catch(() => {});
      return run;
    }
  };
}

async function makeStore(sharedStorage, locks) {
  const store = pilot.createStore({ storage: sharedStorage || storage(), locks: locks || serialLocks() });
  await store.init();
  return store;
}

async function envelopeFromState(state) {
  return pilot.exportEnvelope(state);
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

  await test('origin gate accepts loopback HTTP(S) and rejects hosted, file and other private origins', async () => {
    assert.strictEqual(pilot.allowedOrigin({ protocol: 'http:', hostname: '127.0.0.1' }), true);
    assert.strictEqual(pilot.allowedOrigin({ protocol: 'https:', hostname: 'localhost' }), true);
    assert.strictEqual(pilot.allowedOrigin({ protocol: 'http:', hostname: '::1' }), true);
    assert.strictEqual(pilot.allowedOrigin({ protocol: 'file:', hostname: '' }), false);
    assert.strictEqual(pilot.allowedOrigin({ protocol: 'https:', hostname: 'portfolio.example' }), false);
  });

  await test('canonical hashes retain hostile JSON keys instead of dropping them through object prototypes', async () => {
    const hostile = JSON.parse('{"__proto__":{"proof":"kept"},"safe":"value"}');
    const canonical = pilot.canonicalJson(hostile);
    assert.ok(canonical.includes('__proto__'));
    assert.ok(canonical.includes('proof'));
  });

  await test('review timestamps render in Singapore DD/MM/YYYY format while hashes retain ISO values', async () => {
    assert.match(pilot.formatTimestamp('2026-09-23T16:36:00.000Z'), /^24\/09\/2026, 00:36 SGT$/);
  });

  await test('ten synthetic fixtures use the existing snapshot payload shape and matching pinned links', async () => {
    const dataset = await pilot.syntheticDataset();
    assert.strictEqual(dataset.snapshots.length, 10);
    assert.strictEqual(dataset.notes.length, 10);
    assert.deepStrictEqual(Object.keys(dataset.snapshots[0].payload).sort(), ['byClass', 'date', 'id', 'net']);
    assert.deepStrictEqual(Object.keys(dataset.snapshots[0].payload.byClass).sort(), ['cash', 'cpf', 'crypto', 'insurance', 'realestate', 'stocks']);
    assert.deepStrictEqual(new Set(dataset.notes.map(note => note.category)), new Set(['cash', 'insurance', 'projection']));
    const fixtureState = {
      format: pilot.FORMAT,
      exportSchemaVersion: pilot.EXPORT_SCHEMA_VERSION,
      sourceSchema: pilot.SOURCE_SCHEMA,
      sourceSchemaVersion: pilot.SOURCE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      snapshots: dataset.snapshots,
      notes: dataset.notes
    };
    fixtureState.integrityHash = await pilot.hashState(fixtureState);
    await pilot.validateState(fixtureState);
    dataset.notes.forEach((note, index) => {
      assert.strictEqual(note.snapshotId, dataset.snapshots[index].payload.id);
      assert.strictEqual(note.snapshotHash, dataset.snapshots[index].hash);
    });
  });

  await test('create, edit and review preserve immutable snapshot identity and prior revision detail', async () => {
    const store = await makeStore();
    await store.seedExamples();
    const originalSnapshot = JSON.parse(JSON.stringify(store.state.snapshots[0]));
    const original = store.state.notes[0];
    const updated = await store.updateNote(original.id, {
      snapshotId: original.snapshotId,
      category: original.category,
      decisionType: original.decisionType,
      decisionText: 'Edited synthetic decision',
      reason: 'Edited synthetic reason',
      previousValue: '',
      revisedValue: 'Revised synthetic value',
      evidenceRef: 'Synthetic evidence'
    }, original.revision, original.hash);
    assert.strictEqual(updated.revision, 2);
    assert.strictEqual(updated.history.length, 1);
    assert.strictEqual(updated.history[0].values.decisionText, original.decisionText);
    assert.strictEqual(updated.history[0].values.reason, original.reason);
    assert.strictEqual(updated.snapshotHash, original.snapshotHash);
    assert.deepStrictEqual(store.state.snapshots[0], originalSnapshot);
    const reviewed = await store.reviewNote(updated.id, { comment: 'Reviewed synthetic record' }, updated.revision, updated.hash);
    assert.strictEqual(reviewed.revision, 3);
    assert.strictEqual(reviewed.review.status, 'reviewed');
    assert.strictEqual(reviewed.reviewHistory.length, 1);
    const editedAgain = await store.updateNote(reviewed.id, {
      snapshotId: reviewed.snapshotId,
      category: reviewed.category,
      decisionType: reviewed.decisionType,
      decisionText: 'Edited after review',
      reason: 'New reason',
      previousValue: null,
      revisedValue: null,
      evidenceRef: ''
    }, reviewed.revision, reviewed.hash);
    assert.strictEqual(editedAgain.review.status, 'unreviewed');
    assert.strictEqual(editedAgain.reviewHistory.length, 1);
    assert.strictEqual(editedAgain.history.length, 3);
  });

  await test('blank decision and reason are rejected, while blank values remain null rather than zero', async () => {
    const store = await makeStore();
    const snapshot = store.state.snapshots[0];
    await assert.rejects(() => store.createNote({ id: 'blank-note', snapshotId: snapshot.payload.id, category: 'cash', decisionType: 'decision', decisionText: '   ', reason: 'why', previousValue: '', revisedValue: '', evidenceRef: '' }), error => error.code === 'REQUIRED_TEXT');
    await assert.rejects(() => store.createNote({ id: 'blank-note', snapshotId: snapshot.payload.id, category: 'cash', decisionType: 'decision', decisionText: 'what', reason: '   ', previousValue: '', revisedValue: '', evidenceRef: '' }), error => error.code === 'REQUIRED_TEXT');
    const note = await store.createNote({ id: 'blank-value-note', snapshotId: snapshot.payload.id, category: 'cash', decisionType: 'assumption', decisionText: 'A synthetic assumption', reason: 'A synthetic reason', previousValue: '', revisedValue: '', evidenceRef: '' });
    assert.strictEqual(note.previousValue, null);
    assert.strictEqual(note.revisedValue, null);
    const omitted = await store.createNote({ id: 'omitted-value-note', snapshotId: snapshot.payload.id, category: 'projection', decisionType: 'assumption', decisionText: 'An assumption with omitted values', reason: 'No value was supplied' });
    assert.strictEqual(omitted.previousValue, null);
    assert.strictEqual(omitted.revisedValue, null);
  });

  await test('export and restore preserve identities, schema versions, hashes and immutable history', async () => {
    const store = await makeStore();
    await store.seedExamples();
    const exported = await store.exportJson();
    const target = await makeStore();
    const before = target.state.notes.length;
    const result = await target.restore(exported);
    assert.strictEqual(result.notes, before + 10);
    assert.strictEqual(target.state.notes.length, 10);
    assert.strictEqual(target.state.notes[0].snapshotSourceSchema, pilot.SOURCE_SCHEMA);
    assert.strictEqual(target.state.notes[0].snapshotSchemaVersion, pilot.SOURCE_SCHEMA_VERSION);
    assert.strictEqual(target.state.notes[0].snapshotHash.length, 64);
    await pilot.validateState(target.state);
    const again = await target.restore(exported);
    assert.strictEqual(again.notes, 10, 'identical restore should be idempotent');
  });

  await test('wrong schema, bad export hash, bad snapshot hash and duplicate IDs reject without mutation', async () => {
    const store = await makeStore();
    await store.seedExamples();
    const before = JSON.stringify(store.state);
    const base = JSON.parse(await store.exportJson());
    const wrongSchema = Object.assign({}, base, { exportSchemaVersion: 99 });
    await assert.rejects(() => store.restore(JSON.stringify(wrongSchema)), error => error.code === 'WRONG_SCHEMA');
    const badEnvelope = Object.assign({}, base, { notes: base.notes.map((note, index) => index === 0 ? Object.assign({}, note, { reason: 'tampered' }) : note) });
    await assert.rejects(() => store.restore(JSON.stringify(badEnvelope)), error => error.code === 'BAD_HASH');
    const badSnapshot = JSON.parse(JSON.stringify(base));
    badSnapshot.snapshots[0].hash = '0'.repeat(64);
    const badSnapshotNoHash = Object.assign({}, badSnapshot);
    delete badSnapshotNoHash.integrityHash;
    badSnapshot.integrityHash = await pilot.sha256Hex(pilot.canonicalJson(badSnapshotNoHash));
    await assert.rejects(() => store.restore(JSON.stringify(badSnapshot)), error => error.code === 'BAD_HASH');
    const duplicate = JSON.parse(JSON.stringify(base));
    duplicate.notes.push(JSON.parse(JSON.stringify(duplicate.notes[0])));
    const duplicateNoHash = Object.assign({}, duplicate);
    delete duplicateNoHash.integrityHash;
    duplicate.integrityHash = await pilot.sha256Hex(pilot.canonicalJson(duplicateNoHash));
    await assert.rejects(() => store.restore(JSON.stringify(duplicate)), error => error.code === 'DUPLICATE_ID');
    assert.strictEqual(JSON.stringify(store.state), before, 'rejected imports must not partially mutate the store');
  });

  await test('conflicting IDs reject atomically while a missing historical snapshot remains readable', async () => {
    const store = await makeStore();
    await store.seedExamples();
    const before = JSON.stringify(store.state);
    const incoming = JSON.parse(await store.exportJson());
    incoming.notes[0].reason = 'different content from an older export';
    incoming.notes[0].hash = await pilot.hashNote(incoming.notes[0]);
    const incomingNoHash = Object.assign({}, incoming);
    delete incomingNoHash.integrityHash;
    incoming.integrityHash = await pilot.sha256Hex(pilot.canonicalJson(incomingNoHash));
    await assert.rejects(() => store.restore(JSON.stringify(incoming)), error => error.code === 'IMPORT_ID_CONFLICT');
    assert.strictEqual(JSON.stringify(store.state), before);
    const missing = JSON.parse(await store.exportJson());
    missing.snapshots = missing.snapshots.filter(snapshot => snapshot.payload.id !== missing.notes[0].snapshotId);
    const missingNoHash = Object.assign({}, missing);
    delete missingNoHash.integrityHash;
    missing.integrityHash = await pilot.sha256Hex(pilot.canonicalJson(missingNoHash));
    const parsed = await pilot.parseImport(JSON.stringify(missing));
    assert.strictEqual(pilot.noteSnapshotStatus(parsed.notes[0], parsed.snapshots).status, 'missing');
  });

  await test('stale and missing snapshot links are distinguished without rebinding', async () => {
    const store = await makeStore();
    await store.seedExamples();
    const matching = store.state.notes[0];
    assert.strictEqual(store.snapshotStatus(matching).status, 'matching');
    const stale = JSON.parse(JSON.stringify(matching));
    stale.snapshotHash = 'f'.repeat(64);
    assert.strictEqual(pilot.noteSnapshotStatus(stale, store.state.snapshots).status, 'stale');
    const missing = JSON.parse(JSON.stringify(matching));
    missing.snapshotId = 'historical-snapshot-gone';
    assert.strictEqual(pilot.noteSnapshotStatus(missing, store.state.snapshots).status, 'missing');
  });

  await test('expected revision and hash catch a same-note concurrent edit', async () => {
    const shared = storage();
    const locks = serialLocks();
    const first = await makeStore(shared, locks);
    await first.seedExamples();
    const second = await makeStore(shared, locks);
    const stale = second.state.notes[0];
    const current = first.state.notes[0];
    await first.updateNote(current.id, { snapshotId: current.snapshotId, category: current.category, decisionType: current.decisionType, decisionText: 'Other tab edit', reason: current.reason, previousValue: current.previousValue, revisedValue: current.revisedValue, evidenceRef: current.evidenceRef }, current.revision, current.hash);
    await assert.rejects(() => second.updateNote(stale.id, { snapshotId: stale.snapshotId, category: stale.category, decisionType: stale.decisionType, decisionText: 'Stale tab edit', reason: stale.reason, previousValue: stale.previousValue, revisedValue: stale.revisedValue, evidenceRef: stale.evidenceRef }, stale.revision, stale.hash), error => error.code === 'NOTE_CONFLICT');
    assert.strictEqual(second.state.notes[0].decisionText, stale.decisionText, 'caller draft state is not overwritten by conflict');
  });

  await test('storage failure reports no false success and unavailable locks force read-only', async () => {
    const broken = { getItem() { return null; }, setItem() { throw new Error('quota'); } };
    const failed = pilot.createStore({ storage: broken, locks: serialLocks() });
    await failed.init();
    assert.strictEqual(failed.readOnly, true);
    assert.strictEqual(failed.storageError.code, 'STORAGE_WRITE_FAILED');
    await assert.rejects(() => failed.seedExamples(), error => error.code === 'STORAGE_WRITE_FAILED');
    const readOnly = pilot.createStore({ storage: storage(), locks: null });
    await readOnly.init();
    assert.strictEqual(readOnly.readOnly, true);
    await assert.rejects(() => readOnly.seedExamples(), error => error.code === 'READ_ONLY');
    assert.ok((await readOnly.exportJson()).includes('decision-notes-pilot'));
  });

  await test('empty-store initialisation is serialised and cannot overwrite a concurrent tab', async () => {
    const shared = storage();
    const locks = serialLocks();
    const first = pilot.createStore({ storage: shared, locks });
    const second = pilot.createStore({ storage: shared, locks });
    await Promise.all([first.init(), second.init()]);
    await first.seedExamples();
    await second.init();
    assert.strictEqual(second.state.notes.length, 10);
    assert.strictEqual(JSON.parse(shared.raw(pilot.STORAGE_KEY)).notes.length, 10);
  });

  await test('missing store integrity hash is a recovery state, while explicit historical mode allows missing links', async () => {
    const source = await makeStore();
    await source.seedExamples();
    const rawState = JSON.parse(JSON.stringify(source.state));
    delete rawState.integrityHash;
    const corruptedStorage = storage({ [pilot.STORAGE_KEY]: JSON.stringify(rawState) });
    const recovered = await makeStore(corruptedStorage);
    assert.strictEqual(recovered.readOnly, true);
    assert.strictEqual(recovered.recovery.code, 'BAD_HASH');
    assert.ok(recovered.exportRaw().includes('syn-note-01'));
    const historical = JSON.parse(JSON.stringify(source.state));
    historical.snapshots = [];
    historical.integrityHash = await pilot.hashState(historical);
    await assert.rejects(() => pilot.validateState(historical), error => error.code === 'MISSING_REFERENCE');
    await pilot.validateState(historical, { allowMissingReferences: true });
  });

  await test('impossible calendar dates reject even when their wrapper hash is recomputed', async () => {
    const source = await makeStore();
    const invalid = JSON.parse(JSON.stringify(source.state));
    invalid.snapshots[0].payload.date = '2026-02-30';
    invalid.snapshots[0].hash = await pilot.hashSnapshot(invalid.snapshots[0]);
    invalid.integrityHash = await pilot.hashState(invalid);
    await assert.rejects(() => pilot.validateState(invalid), error => error.code === 'INVALID_SNAPSHOT');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
