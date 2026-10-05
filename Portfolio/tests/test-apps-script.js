/* Source-only Apps Script persistence tests. Synthetic in-memory Sheets only.
   New storage requires manual deployment. Old readers must fail closed after a
   v2 write, rollback requires recovery through this reader, not old backend code. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../Worker/apps-script.gs'), 'utf8');
const INITIAL = '2026-01-01T00:00:00.000Z';
const PREFIX = 'KJR-PAYLOAD-V2:';
const CHUNK = 49000;
let passed = 0, failed = 0;

function payload(id, large = false) {
  return { schema: 'kujira-portfolio', cash: large
    ? Array.from({ length: 24 }, (_, i) => ({ id: id + i, notes: 'x'.repeat(4500) }))
    : [{ id, amount: 1 }] };
}
function body(value) { const copy = { ...value }; delete copy._savedAt; delete copy.lastSeenRemoteAt; return copy; }
function pointer(service) { return JSON.parse(service.cells.get('1,1').slice(PREFIX.length)); }

// Frozen pre-v2 reader from apps-script.gs (source SHA256 92320f8e...).
// Keep its old behaviour so a future header change cannot revive stale A2 data.
function legacyReadPayloadRaw_(sh) {
  const a1 = sh.getRange('A1').getValue();
  const a1Str = a1 ? a1.toString() : '{}';
  let header;
  try { header = JSON.parse(a1Str); } catch (_) { header = null; }
  if (header && header.chunked === true && Number(header.parts) > 0) {
    const parts = Number(header.parts);
    const cells = sh.getRange(2, 1, parts, 1).getValues();
    return cells.map(row => (row[0] != null ? row[0].toString() : '')).join('');
  }
  return a1Str;
}

function backend(initial = payload('previous'), layout = 'raw') {
  const raw = JSON.stringify(initial);
  const cells = new Map([['1,3', INITIAL]]);
  const chunks = [];
  for (let i = 0; i < raw.length; i += CHUNK) chunks.push(raw.slice(i, i + CHUNK));
  if (layout === 'raw') cells.set('1,1', raw);
  else {
    const column = layout === 'legacy-chunks' ? 1 : 4;
    const header = layout === 'legacy-chunks' ? { chunked: true, parts: chunks.length }
      : { chunked: true, storageVersion: 2, column, parts: chunks.length, characters: raw.length, savedAt: INITIAL };
    cells.set('1,1', (layout === 'modern' ? PREFIX : '') + JSON.stringify(header));
    if (layout === 'modern') cells.set('1,4', 'Kujira payload storage v2 (managed)');
    chunks.forEach((chunk, i) => cells.set((i + 2) + ',' + column, chunk));
  }
  let fault = null, readHook = null, held = false;
  const events = [];
  function event(kind, details, action) {
    const entry = { kind, ...details }; events.push(entry);
    if (fault) fault('before', entry);
    const result = action();
    if (fault) fault('after', entry);
    return result;
  }
  const sheet = {
    getLastRow: () => Math.max(1, ...Array.from(cells.keys(), address => Number(address.split(',')[0]))),
    getRange(row, column, rows = 1) {
      if (typeof row === 'string') {
        const match = /^([A-Z])(\d+)$/.exec(row);
        assert.ok(match, 'unexpected range ' + row);
        row = Number(match[2]); column = match[1].charCodeAt(0) - 64;
      }
      const address = row + ',' + column;
      return {
        setNumberFormat() { return this; },
        getValue() {
          const value = cells.get(address) ?? '';
          if (readHook && address === '1,1') { const fn = readHook; readHook = null; fn(); }
          return value;
        },
        getValues() { return Array.from({ length: rows }, (_, i) => [cells.get((row + i) + ',' + column) ?? '']); },
        setValue(value) { event('setValue', { row, column }, () => cells.set(address, value)); return this; },
        setValues(values) {
          event('setValues', { row, column, rows }, () => {
            values.forEach((value, i) => event('chunk', { row: row + i, column }, () => cells.set((row + i) + ',' + column, value[0])));
          }); return this;
        }
      };
    }
  };
  class FixedDate extends Date {
    constructor(value) { super(arguments.length ? value : '2026-10-03T16:00:00.000Z'); }
    static now() { return Date.parse('2026-10-03T16:00:00.000Z'); }
  }
  const context = {
    Date: FixedDate,
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }), flush() { event('flush', {}, () => {}); } },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput(text) { return { text, setMimeType() { return this; } }; } },
    LockService: { getScriptLock: () => ({ waitLock() { if (held) throw new Error('synthetic contention'); held = true; }, releaseLock() { held = false; } }) },
    Logger: { log() {} },
    UrlFetchApp: { fetch() { throw new Error('Network prohibited'); }, fetchAll() { throw new Error('Network prohibited'); } }
  };
  vm.createContext(context);
  vm.runInContext(source + '\nrefreshViews_ = function () {};', context);
  return {
    cells, events,
    get: () => JSON.parse(context.doGet({ parameter: {} }).text),
    post: data => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(data) } }).text),
    legacyGet() { try { return JSON.parse(legacyReadPayloadRaw_(sheet)); } catch (_) { return { error: 'Stored payload unreadable' }; } },
    setFault(fn) { fault = fn; }, afterRead(fn) { readHook = fn; }, lockHeld: () => held
  };
}
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (err) { failed++; console.error('FAIL ' + name); console.error(err.stack || err); }
}

test('legacy raw and chunk layouts migrate without changing the client payload contract', () => {
  for (const layout of ['raw', 'legacy-chunks', 'modern']) {
    const previous = payload('previous', true), next = payload('next', true);
    const service = backend(previous, layout);
    assert.deepEqual(body(service.get()), previous);
    const response = service.post({ ...next, lastSeenRemoteAt: INITIAL });
    assert.equal(response.ok, true);
    assert.ok(service.cells.get('1,1').startsWith(PREFIX));
    assert.equal(pointer(service).column, layout === 'modern' ? 5 : 4);
    assert.equal(pointer(service).savedAt, response.savedAt);
    assert.deepEqual(body(service.get()), next);
    assert.equal(service.get()._savedAt, response.savedAt);
  }
});
test('old backend reader fails closed instead of returning valid stale A2 chunks', () => {
  const previous = payload('previous', true), next = payload('next', true);
  const service = backend(previous, 'legacy-chunks');
  assert.deepEqual(service.legacyGet(), previous);
  assert.equal(service.post({ ...next, lastSeenRemoteAt: INITIAL }).ok, true);
  assert.match(service.legacyGet().error, /unreadable/);
  assert.deepEqual(body(service.get()), next);
  assert.ok(service.cells.get('2,1').includes('previous'), 'old chunks remain, but are never read by the old backend');
});
test('legacy Date and timezone timestamp revisions become canonical ISO in GET and CAS', () => {
  const variants = [new Date(INITIAL), 'Thu Jan 01 2026 08:00:00 GMT+0800 (Singapore Standard Time)', '2026-01-01T08:00:00+08:00'];
  for (const revision of variants) {
    for (const layout of ['raw', 'legacy-chunks']) {
      const service = backend(payload('previous'), layout);
      service.cells.set('1,3', revision);
      assert.equal(service.get()._savedAt, INITIAL);
      const response = service.post({ ...payload('updated'), lastSeenRemoteAt: String(revision) });
      assert.equal(response.ok, true);
      assert.equal(new Date(response.savedAt).toISOString(), response.savedAt);
      assert.equal(service.get()._savedAt, response.savedAt);
    }
  }
});
test('every interrupted staging chunk keeps the previous readable payload and revision', () => {
  for (const layout of ['raw', 'legacy-chunks', 'modern']) for (const failChunk of [0, 1, 2]) for (const phase of ['before', 'after']) {
    const previous = payload('previous', true), service = backend(previous, layout);
    const oldPointer = service.cells.get('1,1'); let count = 0;
    service.setFault((when, event) => {
      if (when === phase && event.kind === 'chunk' && count++ === failChunk) throw new Error('synthetic interrupted chunk');
    });
    assert.match(service.post({ ...payload('next', true), lastSeenRemoteAt: INITIAL }).error, /synthetic interrupted/);
    service.setFault(null);
    assert.equal(service.cells.get('1,1'), oldPointer);
    assert.deepEqual(body(service.get()), previous);
    assert.equal(service.get()._savedAt, INITIAL);
    assert.equal(service.lockHeld(), false);
  }
});
test('silently truncated staging bytes fail verification before publication', () => {
  const service = backend();
  service.setFault((phase, event) => { if (phase === 'after' && event.kind === 'setValues') service.cells.set('2,' + event.column, 'truncated'); });
  assert.match(service.post({ ...payload('next', true), lastSeenRemoteAt: INITIAL }).error, /did not verify/);
  service.setFault(null);
  assert.equal(service.get().cash[0].id, 'previous'); assert.equal(service.get()._savedAt, INITIAL);
});
test('slot allocation refuses to overwrite custom D/E data', () => {
  for (const row of [1, 2, 100]) {
    const service = backend(); service.cells.set(row + ',4', 'synthetic custom content');
    assert.match(service.post({ ...payload('next'), lastSeenRemoteAt: INITIAL }).error, /unrecognised data/);
    assert.equal(service.cells.get(row + ',4'), 'synthetic custom content');
    assert.equal(service.get().cash[0].id, 'previous'); assert.equal(service.get()._savedAt, INITIAL);
  }
});
test('pointer and flush interruptions recover coherent generations even after ambiguous publication', () => {
  for (const stage of ['staging-flush', 'pointer', 'publication-flush']) for (const phase of ['before', 'after']) {
    const previous = payload('previous', true), next = payload('next', true), service = backend(previous, 'modern');
    let flushNumber = 0;
    service.setFault((when, event) => {
      if (event.kind === 'flush' && when === 'before') flushNumber++;
      const matches = stage === 'pointer' ? event.kind === 'setValue' && event.row === 1 && event.column === 1
        : event.kind === 'flush' && flushNumber === (stage === 'staging-flush' ? 1 : 2);
      if (matches && phase === when) throw new Error('synthetic publication interruption');
    });
    assert.match(service.post({ ...next, lastSeenRemoteAt: INITIAL }).error, /synthetic publication/);
    service.setFault(null);
    const recovered = service.get(), committed = stage === 'publication-flush' || (stage === 'pointer' && phase === 'after');
    assert.deepEqual(body(recovered), committed ? next : previous);
    assert.equal(recovered._savedAt === INITIAL, !committed);
    if (committed) {
      assert.equal(service.cells.get('1,3'), INITIAL);
      assert.equal(service.post({ ...payload('stale'), lastSeenRemoteAt: INITIAL }).conflict, true);
    }
    assert.equal(service.post({ ...payload('retry'), lastSeenRemoteAt: recovered._savedAt }).ok, true);
    assert.equal(service.get().cash[0].id, 'retry');
  }
});
test('C1 mirror failure cannot invalidate a save or weaken CAS', () => {
  const service = backend();
  service.setFault((phase, event) => { if (phase === 'before' && event.kind === 'setValue' && event.column === 3) throw new Error('mirror failure'); });
  const response = service.post({ ...payload('committed'), lastSeenRemoteAt: INITIAL });
  assert.equal(response.ok, true); assert.equal(service.cells.get('1,3'), INITIAL);
  assert.equal(service.get()._savedAt, response.savedAt);
  assert.equal(service.post({ ...payload('stale'), lastSeenRemoteAt: INITIAL }).conflict, true);
});
test('GET cannot pair legacy data with an interleaving writer revision', () => {
  const service = backend(); let concurrent;
  service.afterRead(() => { concurrent = service.post({ ...payload('writer'), lastSeenRemoteAt: INITIAL }); });
  const snapshot = service.get();
  assert.match(concurrent.error, /busy/); assert.equal(snapshot.cash[0].id, 'previous'); assert.equal(snapshot._savedAt, INITIAL);
  assert.equal(service.lockHeld(), false);
  assert.equal(service.post({ ...payload('writer'), lastSeenRemoteAt: INITIAL }).ok, true);
  assert.equal(service.post({ ...payload('reader'), lastSeenRemoteAt: snapshot._savedAt }).conflict, true);
});
test('same-millisecond saves receive distinct increasing revisions', () => {
  const service = backend(), first = service.post({ ...payload('one'), lastSeenRemoteAt: INITIAL });
  const second = service.post({ ...payload('two'), lastSeenRemoteAt: first.savedAt });
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.ok(Date.parse(second.savedAt) > Date.parse(first.savedAt));
  assert.equal(service.post({ ...payload('stale'), lastSeenRemoteAt: first.savedAt }).conflict, true);
});
test('shrinking writes alternate slots and retain previous bytes until publication', () => {
  const service = backend(), first = service.post({ ...payload('large', true), lastSeenRemoteAt: INITIAL });
  const initialHeader = pointer(service); service.events.length = 0;
  assert.equal(service.post({ ...payload('small'), lastSeenRemoteAt: first.savedAt }).ok, true);
  assert.ok(service.events.filter(event => event.kind === 'chunk').every(event => event.column !== initialHeader.column));
  assert.deepEqual(body(service.get()), payload('small'));
  assert.ok(service.cells.get('2,' + initialHeader.column).includes('large'));
});
test('invalid or incomplete stored data fails closed and releases the lock', () => {
  for (const broken of ['{', 'null', '[]', JSON.stringify({ chunked: true, parts: 1000000 }), PREFIX + '{}', PREFIX + '{']) {
    const service = backend(); service.cells.set('1,1', broken);
    assert.equal(typeof service.get().error, 'string'); assert.equal(service.lockHeld(), false);
  }
  const service = backend(payload('modern'), 'modern'); service.cells.set('2,4', '{"schema":"kujira-portfolio"}');
  assert.match(service.get().error, /incomplete/);
});
console.log(`\nApps Script tests: ${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
