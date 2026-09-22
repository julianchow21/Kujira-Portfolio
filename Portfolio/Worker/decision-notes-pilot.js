/*
 * Kujira Portfolio decision and assumption notes pilot.
 *
 * This file is deliberately separate from Worker/app.js. It owns one
 * synthetic-only local store, and never imports or initialises the Portfolio
 * database, vault or sync layers. The browser entrypoint refuses to run away
 * from an HTTP(S) loopback origin before it touches storage.
 */
(function decisionNotesPilotModule(root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DecisionNotesPilot = api;
  if (!api.isNode && root.document) {
    root.document.addEventListener('DOMContentLoaded', () => api.startBrowser(), { once: true });
  }
})(typeof window !== 'undefined' ? window : globalThis, function createDecisionNotesPilot(root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const STORAGE_KEY = 'kjr-pf-decision-notes-pilot-v1';
  const LOCK_NAME = 'kjr-pf-decision-notes-pilot-lock-v1';
  const FORMAT = 'kujira-portfolio-decision-notes-pilot';
  const EXPORT_SCHEMA_VERSION = 1;
  const NOTE_SCHEMA_VERSION = 1;
  const SOURCE_SCHEMA = 'kujira-portfolio';
  const SOURCE_SCHEMA_VERSION = 3;
  const APP_VERSION = 'v2.66';
  const MAX_IMPORT_BYTES = 1024 * 1024;
  const HASH_RE = /^[a-f0-9]{64}$/;
  const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
  const CATEGORIES = ['cash', 'insurance', 'projection'];
  const DECISION_TYPES = ['decision', 'assumption'];
  const CLASS_KEYS = ['stocks', 'cash', 'cpf', 'realestate', 'crypto', 'insurance'];
  const REVIEW_STATUSES = ['unreviewed', 'reviewed'];

  const SYNTHETIC_PAYLOADS = Object.freeze([
    { id: 'syn-snap-01', date: '2026-01-31', net: 126000, byClass: { stocks: 52000, cash: 21000, cpf: 30000, realestate: 0, crypto: 3000, insurance: 20000 } },
    { id: 'syn-snap-02', date: '2026-02-28', net: 127500, byClass: { stocks: 52000, cash: 22500, cpf: 30000, realestate: 0, crypto: 3000, insurance: 20000 } },
    { id: 'syn-snap-03', date: '2026-03-31', net: 128100, byClass: { stocks: 52000, cash: 23100, cpf: 30000, realestate: 0, crypto: 3000, insurance: 20000 } },
    { id: 'syn-snap-04', date: '2026-04-30', net: 129400, byClass: { stocks: 53000, cash: 23400, cpf: 30000, realestate: 0, crypto: 3000, insurance: 20000 } },
    { id: 'syn-snap-05', date: '2026-05-31', net: 130200, byClass: { stocks: 53000, cash: 24200, cpf: 30000, realestate: 0, crypto: 3000, insurance: 20000 } },
    { id: 'syn-snap-06', date: '2026-06-30', net: 131100, byClass: { stocks: 54000, cash: 24100, cpf: 30000, realestate: 0, crypto: 3000, insurance: 20000 } },
    { id: 'syn-snap-07', date: '2026-07-31', net: 132600, byClass: { stocks: 54000, cash: 25600, cpf: 30000, realestate: 0, crypto: 3000, insurance: 20000 } },
    { id: 'syn-snap-08', date: '2026-08-31', net: 133400, byClass: { stocks: 55000, cash: 25400, cpf: 30000, realestate: 0, crypto: 3000, insurance: 20000 } },
    { id: 'syn-snap-09', date: '2026-09-15', net: 134200, byClass: { stocks: 55000, cash: 26200, cpf: 30000, realestate: 0, crypto: 3000, insurance: 20000 } },
    { id: 'syn-snap-10', date: '2026-09-22', net: 135000, byClass: { stocks: 56000, cash: 26000, cpf: 30000, realestate: 0, crypto: 3000, insurance: 20000 } }
  ]);

  const SYNTHETIC_NOTE_INPUTS = Object.freeze([
    { category: 'cash', decisionType: 'decision', decisionText: 'Keep the emergency reserve in the instant access account.', reason: 'The reserve needs same day access while the cash buffer is being rebuilt.', previousValue: 'Two months of essential costs', revisedValue: 'Three months of essential costs', evidenceRef: 'Synthetic cash policy example' },
    { category: 'cash', decisionType: 'assumption', decisionText: 'Assume the monthly cash transfer remains unchanged for this review.', reason: 'No new transfer instruction was supplied for the synthetic scenario.', previousValue: null, revisedValue: 'S$800 per month', evidenceRef: 'Synthetic transfer note' },
    { category: 'cash', decisionType: 'decision', decisionText: 'Retain a separate sinking fund for annual bills.', reason: 'Separating known annual costs makes the available reserve easier to review.', previousValue: 'Combined with emergency reserve', revisedValue: 'Separate annual bill fund', evidenceRef: 'Synthetic cash review' },
    { category: 'insurance', decisionType: 'decision', decisionText: 'Review the protection gap before changing any policy.', reason: 'Coverage needs should be checked against current dependants and obligations first.', previousValue: null, revisedValue: 'Review required before change', evidenceRef: 'Synthetic protection checklist' },
    { category: 'insurance', decisionType: 'assumption', decisionText: 'Treat the policy cash value as a recorded reference only.', reason: 'The fixture does not establish a current surrender quote or outcome.', previousValue: 'Unknown', revisedValue: 'Recorded reference, not verified value', evidenceRef: 'Synthetic policy register' },
    { category: 'insurance', decisionType: 'decision', decisionText: 'Keep the premium review date visible in the next review.', reason: 'A date makes the later review explicit without changing policy data.', previousValue: 'Not recorded', revisedValue: 'Annual review marker', evidenceRef: 'Synthetic premium review' },
    { category: 'projection', decisionType: 'assumption', decisionText: 'Use the stated savings rate as an unverified projection input.', reason: 'The rate is a scenario input and has not been checked against a live record.', previousValue: null, revisedValue: 'Scenario rate supplied by user', evidenceRef: 'Synthetic projection scenario' },
    { category: 'projection', decisionType: 'decision', decisionText: 'Keep the retirement horizon unchanged for this comparison.', reason: 'Changing the horizon would make the synthetic comparison harder to interpret.', previousValue: 'Age 60', revisedValue: 'Age 60', evidenceRef: 'Synthetic horizon review' },
    { category: 'projection', decisionType: 'assumption', decisionText: 'Leave missing future income inputs blank until supplied.', reason: 'A missing input must not be treated as zero or as a verified fact.', previousValue: null, revisedValue: null, evidenceRef: 'Synthetic missing input case' },
    { category: 'projection', decisionType: 'decision', decisionText: 'Review the projection after the next stated assumption change.', reason: 'The review should explain the change before comparing derived figures.', previousValue: 'No review date', revisedValue: 'Next assumption change', evidenceRef: 'Synthetic projection review' }
  ]);

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function canonicalise(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw pilotError('INVALID_NUMBER', 'Only finite numbers are allowed.');
      return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) return value.map(canonicalise);
    if (isPlainObject(value)) {
      const out = Object.create(null);
      Object.keys(value).sort().forEach(key => { out[key] = canonicalise(value[key]); });
      return out;
    }
    throw pilotError('INVALID_VALUE', 'Unsupported value in the pilot record.');
  }

  function canonicalJson(value) {
    return JSON.stringify(canonicalise(value));
  }

  async function sha256Hex(text) {
    const input = String(text);
    if (!isNode && root.crypto && root.crypto.subtle && typeof root.TextEncoder === 'function') {
      const bytes = new root.TextEncoder().encode(input);
      const digest = await root.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    if (isNode) {
      return require('crypto').createHash('sha256').update(input, 'utf8').digest('hex');
    }
    throw pilotError('HASH_UNAVAILABLE', 'SHA-256 is unavailable in this browser. The pilot is read-only.');
  }

  function pilotError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    if (details !== undefined) error.details = details;
    return error;
  }

  function allowedOrigin(locationLike) {
    if (!locationLike) return false;
    const protocol = String(locationLike.protocol || '').toLowerCase();
    const hostname = String(locationLike.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return (protocol === 'http:' || protocol === 'https:') &&
      (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1');
  }

  function assertId(value, label) {
    if (typeof value !== 'string' || !ID_RE.test(value)) throw pilotError('INVALID_ID', (label || 'ID') + ' is invalid.');
    return value;
  }

  function assertString(value, label, maxLength) {
    if (typeof value !== 'string' || value.length > (maxLength || 2000)) {
      throw pilotError('INVALID_TEXT', (label || 'Text') + ' is invalid or too long.');
    }
    return value;
  }

  function requiredText(value, label, maxLength) {
    const text = assertString(value, label, maxLength);
    if (!text.trim()) throw pilotError('REQUIRED_TEXT', (label || 'Text') + ' cannot be blank.');
    return text;
  }

  function nullableText(value, label) {
    if (value === null || value === undefined || value === '') return null;
    return assertString(value, label, 2000);
  }

  function isoNow() {
    return new Date().toISOString();
  }

  function validIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value || 'Unknown time');
    try {
      const parts = new Intl.DateTimeFormat('en-SG', {
        timeZone: 'Asia/Singapore', day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(date).reduce((out, part) => { out[part.type] = part.value; return out; }, {});
      return parts.day + '/' + parts.month + '/' + parts.year + ', ' + parts.hour + ':' + parts.minute + ' SGT';
    } catch (_) {
      return date.toISOString();
    }
  }

  function snapshotHashInput(snapshot) {
    return {
      sourceSchema: snapshot.sourceSchema,
      sourceSchemaVersion: snapshot.sourceSchemaVersion,
      payload: snapshot.payload
    };
  }

  async function hashSnapshot(snapshot) {
    return sha256Hex(canonicalJson(snapshotHashInput(snapshot)));
  }

  function noteHashInput(note) {
    const copy = clone(note);
    delete copy.hash;
    return copy;
  }

  async function hashNote(note) {
    return sha256Hex(canonicalJson(noteHashInput(note)));
  }

  function stateHashInput(state) {
    const copy = clone(state);
    delete copy.integrityHash;
    return copy;
  }

  async function hashState(state) {
    return sha256Hex(canonicalJson(stateHashInput(state)));
  }

  function historyHashInput(noteId, revision, values) {
    return { noteId, revision, values };
  }

  async function hashHistory(noteId, revision, values) {
    return sha256Hex(canonicalJson(historyHashInput(noteId, revision, values)));
  }

  function noteValues(note) {
    return {
      noteSchemaVersion: note.noteSchemaVersion,
      snapshotId: note.snapshotId,
      snapshotSourceSchema: note.snapshotSourceSchema,
      snapshotSchemaVersion: note.snapshotSchemaVersion,
      snapshotHash: note.snapshotHash,
      category: note.category,
      decisionType: note.decisionType,
      decisionText: note.decisionText,
      reason: note.reason,
      previousValue: note.previousValue,
      revisedValue: note.revisedValue,
      evidenceRef: note.evidenceRef,
      review: note.review,
      reviewHistory: note.reviewHistory
    };
  }

  async function makeSnapshot(payload, sourceSchema, sourceSchemaVersion) {
    const snapshot = {
      sourceSchema: sourceSchema || SOURCE_SCHEMA,
      sourceSchemaVersion: sourceSchemaVersion || SOURCE_SCHEMA_VERSION,
      payload: clone(payload)
    };
    snapshot.hash = await hashSnapshot(snapshot);
    return snapshot;
  }

  async function makeNote(input, snapshot, now) {
    if (!snapshot || !snapshot.payload) throw pilotError('MISSING_SNAPSHOT', 'A note must link to a snapshot.');
    const note = {
      id: assertId(input.id, 'Note ID'),
      noteSchemaVersion: NOTE_SCHEMA_VERSION,
      snapshotId: assertId(snapshot.payload.id, 'Snapshot ID'),
      snapshotSourceSchema: snapshot.sourceSchema,
      snapshotSchemaVersion: snapshot.sourceSchemaVersion,
      snapshotHash: snapshot.hash,
      category: CATEGORIES.includes(input.category) ? input.category : null,
      decisionType: DECISION_TYPES.includes(input.decisionType) ? input.decisionType : null,
      decisionText: requiredText(input.decisionText || '', 'Decision or assumption', 2000),
      reason: requiredText(input.reason || '', 'Reason', 2000),
      previousValue: nullableText(input.previousValue, 'Previous value'),
      revisedValue: nullableText(input.revisedValue, 'Revised value'),
      evidenceRef: assertString(input.evidenceRef || '', 'Evidence reference', 1000),
      createdAt: now || isoNow(),
      updatedAt: now || isoNow(),
      provenance: { kind: 'synthetic-local', source: input.provenanceSource || 'local-entry' },
      revision: 1,
      history: [],
      review: { status: 'unreviewed', reviewedAt: null, comment: '', provenance: 'synthetic-local' },
      reviewHistory: []
    };
    if (!note.category) throw pilotError('INVALID_CATEGORY', 'Choose cash, insurance or projection.');
    if (!note.decisionType) throw pilotError('INVALID_DECISION_TYPE', 'Choose decision or assumption.');
    note.hash = await hashNote(note);
    return note;
  }

  async function syntheticSnapshots() {
    return Promise.all(SYNTHETIC_PAYLOADS.map(payload => makeSnapshot(payload)));
  }

  async function syntheticDataset() {
    const snapshots = await syntheticSnapshots();
    const notes = [];
    for (let i = 0; i < SYNTHETIC_NOTE_INPUTS.length; i++) {
      notes.push(await makeNote(Object.assign({}, SYNTHETIC_NOTE_INPUTS[i], {
        id: 'syn-note-' + String(i + 1).padStart(2, '0'),
        provenanceSource: 'ten-example-seed'
      }), snapshots[i], '2026-09-22T12:00:00.000Z'));
    }
    return { snapshots, notes };
  }

  async function initialState() {
    const dataset = await syntheticDataset();
    const state = {
      format: FORMAT,
      exportSchemaVersion: EXPORT_SCHEMA_VERSION,
      sourceSchema: SOURCE_SCHEMA,
      sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
      updatedAt: isoNow(),
      snapshots: dataset.snapshots,
      notes: []
    };
    state.integrityHash = await hashState(state);
    return state;
  }

  function ensureArray(value, label) {
    if (!Array.isArray(value)) throw pilotError('INVALID_SHAPE', label + ' must be an array.');
    return value;
  }

  async function validateSnapshot(snapshot) {
    if (!isPlainObject(snapshot)) throw pilotError('INVALID_SNAPSHOT', 'A snapshot wrapper is invalid.');
    if (snapshot.sourceSchema !== SOURCE_SCHEMA || snapshot.sourceSchemaVersion !== SOURCE_SCHEMA_VERSION) {
      throw pilotError('WRONG_SOURCE_SCHEMA', 'Snapshot source schema must be kujira-portfolio version 3.');
    }
    if (!isPlainObject(snapshot.payload)) throw pilotError('INVALID_SNAPSHOT', 'Snapshot payload is missing.');
    const payload = snapshot.payload;
    assertId(payload.id, 'Snapshot ID');
    if (!validIsoDate(payload.date)) throw pilotError('INVALID_SNAPSHOT', 'Snapshot date is invalid.');
    if (typeof payload.net !== 'number' || !Number.isFinite(payload.net)) throw pilotError('INVALID_SNAPSHOT', 'Snapshot net value is invalid.');
    if (!isPlainObject(payload.byClass) || Object.keys(payload.byClass).sort().join(',') !== CLASS_KEYS.slice().sort().join(',')) {
      throw pilotError('INVALID_SNAPSHOT', 'Snapshot byClass must match the Portfolio snapshot shape.');
    }
    CLASS_KEYS.forEach(key => {
      if (typeof payload.byClass[key] !== 'number' || !Number.isFinite(payload.byClass[key])) throw pilotError('INVALID_SNAPSHOT', 'Snapshot class value is invalid.');
    });
    if (typeof snapshot.hash !== 'string' || !HASH_RE.test(snapshot.hash)) throw pilotError('BAD_HASH', 'Snapshot integrity hash is invalid.');
    if (await hashSnapshot(snapshot) !== snapshot.hash) throw pilotError('BAD_HASH', 'Snapshot integrity hash does not match its payload.');
    return true;
  }

  async function validateHistory(note) {
    if (!Array.isArray(note.history)) throw pilotError('INVALID_HISTORY', 'Note revision history is invalid.');
    if (note.history.length !== note.revision - 1) throw pilotError('INVALID_HISTORY', 'Note revision history does not cover every prior revision.');
    let expected = 1;
    for (const entry of note.history) {
      if (!isPlainObject(entry) || entry.revision !== expected || !isPlainObject(entry.values) || typeof entry.changedAt !== 'string' || !Number.isFinite(Date.parse(entry.changedAt)) || !isPlainObject(entry.provenance) || entry.provenance.kind !== 'synthetic-local' || typeof entry.provenance.source !== 'string') {
        throw pilotError('INVALID_HISTORY', 'A prior note revision is invalid.');
      }
      const fields = ['noteSchemaVersion', 'snapshotId', 'snapshotSourceSchema', 'snapshotSchemaVersion', 'snapshotHash', 'category', 'decisionType', 'decisionText', 'reason', 'previousValue', 'revisedValue', 'evidenceRef', 'review', 'reviewHistory'];
      if (fields.some(field => !Object.prototype.hasOwnProperty.call(entry.values, field))) throw pilotError('INVALID_HISTORY', 'A prior note revision is missing fields.');
      if (typeof entry.hash !== 'string' || !HASH_RE.test(entry.hash) || await hashHistory(note.id, entry.revision, entry.values) !== entry.hash) {
        throw pilotError('BAD_HISTORY_HASH', 'A prior note revision hash does not match.');
      }
      expected++;
    }
  }

  async function validateNote(note) {
    if (!isPlainObject(note)) throw pilotError('INVALID_NOTE', 'A decision note is invalid.');
    assertId(note.id, 'Note ID');
    if (note.noteSchemaVersion !== NOTE_SCHEMA_VERSION) throw pilotError('WRONG_NOTE_SCHEMA', 'Note schema version is not supported.');
    assertId(note.snapshotId, 'Snapshot ID');
    if (note.snapshotSourceSchema !== SOURCE_SCHEMA || note.snapshotSchemaVersion !== SOURCE_SCHEMA_VERSION || typeof note.snapshotHash !== 'string' || !HASH_RE.test(note.snapshotHash)) throw pilotError('INVALID_REFERENCE', 'Note snapshot reference is invalid.');
    if (!CATEGORIES.includes(note.category) || !DECISION_TYPES.includes(note.decisionType)) throw pilotError('INVALID_NOTE', 'Note category or type is invalid.');
    requiredText(note.decisionText, 'Decision or assumption', 2000);
    requiredText(note.reason, 'Reason', 2000);
    if (note.previousValue !== null) assertString(note.previousValue, 'Previous value', 2000);
    if (note.revisedValue !== null) assertString(note.revisedValue, 'Revised value', 2000);
    assertString(note.evidenceRef, 'Evidence reference', 1000);
    if (typeof note.createdAt !== 'string' || !Number.isFinite(Date.parse(note.createdAt)) || typeof note.updatedAt !== 'string' || !Number.isFinite(Date.parse(note.updatedAt))) throw pilotError('INVALID_NOTE', 'Note timestamps are invalid.');
    if (!isPlainObject(note.provenance) || note.provenance.kind !== 'synthetic-local' || typeof note.provenance.source !== 'string') throw pilotError('INVALID_PROVENANCE', 'Note provenance is invalid.');
    if (!Number.isInteger(note.revision) || note.revision < 1) throw pilotError('INVALID_REVISION', 'Note revision is invalid.');
    if (!isPlainObject(note.review) || !REVIEW_STATUSES.includes(note.review.status) || (note.review.reviewedAt !== null && typeof note.review.reviewedAt !== 'string') || typeof note.review.comment !== 'string' || note.review.provenance !== 'synthetic-local') throw pilotError('INVALID_REVIEW', 'Note review record is invalid.');
    if (!Array.isArray(note.reviewHistory)) throw pilotError('INVALID_REVIEW', 'Note review history is invalid.');
    for (const review of note.reviewHistory) {
      if (!isPlainObject(review) || !REVIEW_STATUSES.includes(review.status) || typeof review.recordedAt !== 'string' || typeof review.comment !== 'string' || review.provenance !== 'synthetic-local') throw pilotError('INVALID_REVIEW', 'A prior review record is invalid.');
    }
    await validateHistory(note);
    if (typeof note.hash !== 'string' || !HASH_RE.test(note.hash) || await hashNote(note) !== note.hash) throw pilotError('BAD_HASH', 'Note integrity hash does not match its content.');
    return true;
  }

  async function validateState(state, options) {
    options = options || {};
    if (!isPlainObject(state) || state.format !== FORMAT || state.exportSchemaVersion !== EXPORT_SCHEMA_VERSION || state.sourceSchema !== SOURCE_SCHEMA || state.sourceSchemaVersion !== SOURCE_SCHEMA_VERSION) {
      throw pilotError('WRONG_SCHEMA', 'This file is not a supported decision notes pilot export.');
    }
    ensureArray(state.snapshots, 'Snapshots');
    ensureArray(state.notes, 'Notes');
    if (state.snapshots.length > 100 || state.notes.length > 500) throw pilotError('SIZE_LIMIT', 'The pilot export is larger than the supported limit.');
    const snapshotIds = new Set();
    for (const snapshot of state.snapshots) {
      if (snapshotIds.has(snapshot && snapshot.payload && snapshot.payload.id)) throw pilotError('DUPLICATE_ID', 'The export contains duplicate snapshot IDs.');
      await validateSnapshot(snapshot);
      snapshotIds.add(snapshot.payload.id);
    }
    const noteIds = new Set();
    for (const note of state.notes) {
      if (noteIds.has(note && note.id)) throw pilotError('DUPLICATE_ID', 'The export contains duplicate note IDs.');
      await validateNote(note);
      noteIds.add(note.id);
    }
    const requireIntegrity = options.requireIntegrity !== false;
    if (requireIntegrity && (typeof state.integrityHash !== 'string' || !HASH_RE.test(state.integrityHash))) throw pilotError('BAD_HASH', 'Store integrity hash is missing.');
    if (state.integrityHash && (typeof state.integrityHash !== 'string' || !HASH_RE.test(state.integrityHash) || await hashState(state) !== state.integrityHash)) throw pilotError('BAD_HASH', 'Store integrity hash does not match.');
    if (!options.allowMissingReferences) {
      const snapshotMap = new Map(state.snapshots.map(snapshot => [snapshot.payload.id, snapshot]));
      for (const note of state.notes) {
        const snapshot = snapshotMap.get(note.snapshotId);
        if (!snapshot) throw pilotError('MISSING_REFERENCE', 'A note links to a snapshot that is unavailable in this state.');
        if (snapshot.sourceSchema !== note.snapshotSourceSchema || snapshot.sourceSchemaVersion !== note.snapshotSchemaVersion || snapshot.hash !== note.snapshotHash) throw pilotError('STALE_REFERENCE', 'A note links to a snapshot with a different schema version or hash.');
      }
    }
    return true;
  }

  function noteSnapshotStatus(note, snapshots) {
    const snapshot = (snapshots || []).find(item => item && item.payload && item.payload.id === note.snapshotId);
    if (!snapshot) return { status: 'missing', snapshot: null, label: 'Missing snapshot' };
    if (snapshot.sourceSchema !== note.snapshotSourceSchema || snapshot.sourceSchemaVersion !== note.snapshotSchemaVersion || snapshot.hash !== note.snapshotHash) {
      return { status: 'stale', snapshot, label: 'Stale link' };
    }
    return { status: 'matching', snapshot, label: 'Snapshot matches' };
  }

  function noteContentForHistory(note) {
    return noteValues(note);
  }

  async function reviseNote(note, changes, kind) {
    const priorValues = noteContentForHistory(note);
    const next = Object.assign({}, note, changes);
    next.updatedAt = isoNow();
    next.revision = note.revision + 1;
    next.history = note.history.concat([{
      revision: note.revision,
      values: priorValues,
      changedAt: note.updatedAt,
      provenance: { kind: 'synthetic-local', source: kind || 'edit' },
      hash: await hashHistory(note.id, note.revision, priorValues)
    }]);
    next.hash = await hashNote(next);
    return next;
  }

  function readStorage(storage, key) {
    try { return storage.getItem(key); } catch (error) { throw pilotError('STORAGE_READ_FAILED', 'Local pilot storage could not be read. Export raw recovery data before repair.', error && error.message); }
  }

  function writeStorage(storage, key, value) {
    try { storage.setItem(key, value); } catch (error) { throw pilotError('STORAGE_WRITE_FAILED', 'Local pilot storage rejected the save. Your current record was kept in memory and nothing was reported as saved.', error && error.message); }
  }

  function sameJson(left, right) {
    return canonicalJson(left) === canonicalJson(right);
  }

  async function exportEnvelope(state) {
    const payload = {
      format: FORMAT,
      exportSchemaVersion: EXPORT_SCHEMA_VERSION,
      sourceSchema: SOURCE_SCHEMA,
      sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
      exportedAt: isoNow(),
      snapshots: clone(state.snapshots),
      notes: clone(state.notes)
    };
    payload.integrityHash = await sha256Hex(canonicalJson(payload));
    return payload;
  }

  async function parseImport(text) {
    if (typeof text !== 'string') throw pilotError('IMPORT_INVALID', 'Choose a JSON export to restore.');
    if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw pilotError('IMPORT_TOO_LARGE', 'This export is larger than the 1 MB pilot limit.');
    let payload;
    try { payload = JSON.parse(text); } catch (_) { throw pilotError('IMPORT_INVALID_JSON', 'The selected file is not valid JSON.'); }
    if (!isPlainObject(payload) || payload.format !== FORMAT || payload.exportSchemaVersion !== EXPORT_SCHEMA_VERSION || payload.sourceSchema !== SOURCE_SCHEMA || payload.sourceSchemaVersion !== SOURCE_SCHEMA_VERSION || typeof payload.integrityHash !== 'string' || !HASH_RE.test(payload.integrityHash)) throw pilotError('WRONG_SCHEMA', 'This file has the wrong pilot format or schema version.');
    const copy = clone(payload);
    const expectedHash = copy.integrityHash;
    delete copy.integrityHash;
    if (await sha256Hex(canonicalJson(copy)) !== expectedHash) throw pilotError('BAD_HASH', 'The export integrity hash is invalid. Nothing was restored.');
    const state = {
      format: payload.format,
      exportSchemaVersion: payload.exportSchemaVersion,
      sourceSchema: payload.sourceSchema,
      sourceSchemaVersion: payload.sourceSchemaVersion,
      updatedAt: payload.exportedAt,
      snapshots: payload.snapshots,
      notes: payload.notes
    };
    await validateState(state, { allowMissingReferences: true, requireIntegrity: false });
    return state;
  }

  async function mergeState(current, incoming) {
    const snapshotMap = new Map(current.snapshots.map(item => [item.payload.id, item]));
    for (const incomingSnapshot of incoming.snapshots) {
      const id = incomingSnapshot.payload.id;
      const existing = snapshotMap.get(id);
      if (existing && !sameJson(existing, incomingSnapshot)) throw pilotError('IMPORT_ID_CONFLICT', 'Snapshot ' + id + ' already exists with different content. Export current data and resolve the conflict before restoring.');
      if (!existing) snapshotMap.set(id, clone(incomingSnapshot));
    }
    const noteMap = new Map(current.notes.map(item => [item.id, item]));
    for (const incomingNote of incoming.notes) {
      const existing = noteMap.get(incomingNote.id);
      if (existing && !sameJson(existing, incomingNote)) throw pilotError('IMPORT_ID_CONFLICT', 'Note ' + incomingNote.id + ' already exists with different content or a newer revision. Export current data and resolve the conflict before restoring.');
      if (!existing) noteMap.set(incomingNote.id, clone(incomingNote));
    }
    const next = Object.assign({}, current, {
      updatedAt: isoNow(),
      snapshots: Array.from(snapshotMap.values()),
      notes: Array.from(noteMap.values())
    });
    next.integrityHash = await hashState(next);
    return next;
  }

  function lockProvider(options) {
    if (options && options.locks) return options.locks;
    if (!isNode && root.navigator && root.navigator.locks) return root.navigator.locks;
    return null;
  }

  function createStore(options) {
    options = options || {};
    const storage = options.storage || (!isNode && root.localStorage ? root.localStorage : null);
    const locks = lockProvider(options);
    const store = {
      state: null,
      recovery: null,
      rawCorrupt: null,
      storageError: null,
      readOnly: !locks,
      lockAvailable: !!locks,
      async init() {
        this.recovery = null;
        this.rawCorrupt = null;
        this.storageError = null;
        this.readOnly = !locks;
        if (!storage) {
          this.storageError = pilotError('STORAGE_UNAVAILABLE', 'Local storage is unavailable. The pilot is read-only.');
          this.readOnly = true;
          return this;
        }
        try {
          const loadOrCreate = async () => {
            const raw = readStorage(storage, STORAGE_KEY);
            if (!raw) {
              const fresh = await initialState();
              if (locks) await this._persist(fresh);
              else this.state = fresh;
              return;
            }
            const parsed = JSON.parse(raw);
            await validateState(parsed, { allowMissingReferences: true });
            this.state = parsed;
          };
          if (locks && typeof locks.request === 'function') {
            await locks.request(LOCK_NAME, { mode: 'exclusive' }, loadOrCreate);
          } else {
            await loadOrCreate();
          }
          // A successful reload clears an earlier recovery marker. The only
          // intentional read-only state left here is the lack of safe locks.
          this.recovery = null;
          this.rawCorrupt = null;
          this.storageError = null;
          this.readOnly = !locks;
        } catch (error) {
          if (error && error.code === 'STORAGE_READ_FAILED') this.storageError = error;
          else if (error && error.code === 'STORAGE_WRITE_FAILED') this.storageError = error;
          else {
            this.recovery = error;
            try { this.rawCorrupt = readStorage(storage, STORAGE_KEY); } catch (_) { this.rawCorrupt = null; }
          }
          this.readOnly = true;
        }
        return this;
      },
      async _readLatest() {
        const raw = readStorage(storage, STORAGE_KEY);
        if (!raw) return await initialState();
        try {
          const parsed = JSON.parse(raw);
          await validateState(parsed, { allowMissingReferences: true });
          return parsed;
        } catch (error) {
          this.recovery = error;
          this.rawCorrupt = raw;
          throw error.code ? error : pilotError('RECOVERY_REQUIRED', 'Stored pilot data is malformed. Export raw recovery data before repair.');
        }
      },
      async _persist(next) {
        const candidate = clone(next);
        candidate.integrityHash = await hashState(candidate);
        writeStorage(storage, STORAGE_KEY, JSON.stringify(candidate));
        this.state = candidate;
        this.storageError = null;
        return true;
      },
      async _mutate(operation) {
        if (this.readOnly) throw this.recovery || this.storageError || pilotError('READ_ONLY', this.lockAvailable ? 'The pilot is read-only until storage recovery is complete.' : 'Safe concurrent locking is unavailable, so this pilot is read-only.');
        if (!locks || typeof locks.request !== 'function') {
          this.readOnly = true;
          throw pilotError('LOCK_UNAVAILABLE', 'Safe concurrent locking is unavailable, so this pilot is read-only.');
        }
        try {
          return await locks.request(LOCK_NAME, { mode: 'exclusive' }, async () => {
            const current = await this._readLatest();
            const candidate = clone(current);
            const result = await operation(candidate, current);
            await validateState(candidate, { allowMissingReferences: true });
            await this._persist(candidate);
            return result;
          });
        } catch (error) {
          if (error && error.code === 'STORAGE_WRITE_FAILED') this.storageError = error;
          throw error;
        }
      },
      getState() { return clone(this.state); },
      getRawRecovery() { return this.rawCorrupt; },
      snapshotStatus(note) { return noteSnapshotStatus(note, this.state ? this.state.snapshots : []); },
      async createNote(input) {
        return this._mutate(async candidate => {
          const snapshot = candidate.snapshots.find(item => item.payload.id === input.snapshotId);
          if (!snapshot) throw pilotError('MISSING_SNAPSHOT', 'Choose a matching snapshot before creating a new note.');
          const status = noteSnapshotStatus({ snapshotId: input.snapshotId, snapshotSourceSchema: snapshot.sourceSchema, snapshotSchemaVersion: snapshot.sourceSchemaVersion, snapshotHash: snapshot.hash }, candidate.snapshots);
          if (status.status !== 'matching') throw pilotError('INVALID_REFERENCE', 'New notes must link to a matching immutable snapshot.');
          if (candidate.notes.some(note => note.id === input.id)) throw pilotError('DUPLICATE_ID', 'That note ID already exists.');
          const note = await makeNote(input, snapshot);
          candidate.notes.push(note);
          candidate.notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
          candidate.updatedAt = isoNow();
          candidate.integrityHash = await hashState(candidate);
          return note;
        });
      },
      async updateNote(id, changes, expectedRevision, expectedHash) {
        return this._mutate(async candidate => {
          const index = candidate.notes.findIndex(note => note.id === id);
          if (index < 0) throw pilotError('MISSING_NOTE', 'The note no longer exists.');
          const current = candidate.notes[index];
          if (current.revision !== expectedRevision || current.hash !== expectedHash) throw pilotError('NOTE_CONFLICT', 'This note changed in another tab. Your draft is still open. Reload the current record or export the current notes before retrying.');
          const next = await reviseNote(current, {
            category: changes.category,
            decisionType: changes.decisionType,
            decisionText: requiredText(changes.decisionText || '', 'Decision or assumption', 2000),
            reason: requiredText(changes.reason || '', 'Reason', 2000),
            previousValue: nullableText(changes.previousValue, 'Previous value'),
            revisedValue: nullableText(changes.revisedValue, 'Revised value'),
            evidenceRef: assertString(changes.evidenceRef || '', 'Evidence reference', 1000),
            review: { status: 'unreviewed', reviewedAt: null, comment: '', provenance: 'synthetic-local' }
          }, 'edit');
          if (!CATEGORIES.includes(next.category) || !DECISION_TYPES.includes(next.decisionType)) throw pilotError('INVALID_NOTE', 'Note category or type is invalid.');
          candidate.notes[index] = next;
          candidate.updatedAt = isoNow();
          candidate.integrityHash = await hashState(candidate);
          return next;
        });
      },
      async reviewNote(id, reviewInput, expectedRevision, expectedHash) {
        return this._mutate(async candidate => {
          const index = candidate.notes.findIndex(note => note.id === id);
          if (index < 0) throw pilotError('MISSING_NOTE', 'The note no longer exists.');
          const current = candidate.notes[index];
          if (current.revision !== expectedRevision || current.hash !== expectedHash) throw pilotError('NOTE_CONFLICT', 'This note changed in another tab. Reload the current record before recording a review.');
          const comment = assertString((reviewInput && reviewInput.comment) || '', 'Review comment', 2000);
          const now = isoNow();
          const next = await reviseNote(current, {
            review: { status: 'reviewed', reviewedAt: now, comment, provenance: 'synthetic-local' },
            reviewHistory: current.reviewHistory.concat([{ status: 'reviewed', recordedAt: now, comment, provenance: 'synthetic-local' }])
          }, 'review');
          candidate.notes[index] = next;
          candidate.updatedAt = now;
          candidate.integrityHash = await hashState(candidate);
          return next;
        });
      },
      async seedExamples() {
        const dataset = await syntheticDataset();
        return this._mutate(async candidate => {
          const incoming = Object.assign({}, candidate, { snapshots: dataset.snapshots, notes: dataset.notes });
          const merged = await mergeState(candidate, incoming);
          candidate.snapshots = merged.snapshots;
          candidate.notes = merged.notes;
          candidate.updatedAt = merged.updatedAt;
          candidate.integrityHash = merged.integrityHash;
          return candidate.notes.length;
        });
      },
      async restore(text) {
        const incoming = await parseImport(text);
        return this._mutate(async candidate => {
          const merged = await mergeState(candidate, incoming);
          candidate.snapshots = merged.snapshots;
          candidate.notes = merged.notes;
          candidate.updatedAt = merged.updatedAt;
          candidate.integrityHash = merged.integrityHash;
          return { notes: candidate.notes.length, snapshots: candidate.snapshots.length };
        });
      },
      async exportJson() {
        if (!this.state) throw pilotError('NO_STATE', 'There is no current pilot state to export.');
        const envelope = await exportEnvelope(this.state);
        return JSON.stringify(envelope, null, 2);
      },
      exportRaw() {
        if (this.rawCorrupt !== null) return this.rawCorrupt;
        if (!this.state) throw pilotError('NO_STATE', 'There is no raw pilot state to export.');
        return JSON.stringify(this.state, null, 2);
      }
    };
    return store;
  }

  function getById(id) { return root.document && root.document.getElementById(id); }

  function setText(id, value) {
    const node = getById(id);
    if (node) node.textContent = value == null ? '' : String(value);
    return node;
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(root.document.createElement('a'), { href: url, download: filename });
    link.style.display = 'none';
    root.document.body.appendChild(link);
    link.click();
    root.document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  function domElement(tag, className, text) {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function startBrowser() {
    const blocked = getById('pilot-blocked');
    const app = getById('pilot-app');
    if (!allowedOrigin(root.location)) {
      if (app) app.hidden = true;
      if (blocked) {
        blocked.hidden = false;
        setText('pilot-blocked-reason', 'This synthetic pilot only runs on localhost, 127.0.0.1 or ::1 over HTTP(S). No local storage was opened.');
      }
      return null;
    }
    if (blocked) blocked.hidden = true;
    if (app) app.hidden = false;
    return mountBrowser();
  }

  async function mountBrowser() {
    let store;
    try {
      store = createStore({ storage: root.localStorage, locks: root.navigator && root.navigator.locks });
      await store.init();
    } catch (error) {
      setText('pilot-error-copy', error.message || 'The pilot could not start.');
      const errorBox = getById('pilot-error');
      if (errorBox) errorBox.hidden = false;
      return null;
    }

    let editing = null;
    let draftConflict = false;
    let saving = false;
    const noteList = getById('pilot-note-list');
    const form = getById('pilot-note-form');
    const snapshotSelect = getById('note-snapshot');
    const submit = getById('note-submit');
    const cancel = getById('note-cancel');
    const reload = getById('note-reload');
    const reviewComment = getById('note-review-comment');

    function setError(error, recovery) {
      const box = getById('pilot-error');
      if (!box) return;
      box.hidden = !error;
      setText('pilot-error-copy', error ? (error.message || String(error)) : '');
      const recoveryButton = getById('pilot-export-recovery');
      if (recoveryButton) recoveryButton.hidden = !recovery;
    }

    function showExportPreview(text, kind) {
      const panel = getById('pilot-export-panel');
      const preview = getById('pilot-export-preview');
      const label = getById('pilot-export-preview-label');
      if (preview) preview.value = text;
      if (label) label.textContent = kind === 'recovery' ? 'Raw recovery data, review before repair' : 'Latest integrity checked export';
      if (panel) {
        panel.hidden = false;
        panel.open = true;
      }
    }

    function updateStatus() {
      const current = store.getState();
      const notes = current ? current.notes.length : 0;
      const snapshots = current ? current.snapshots.length : 0;
      setText('pilot-count', notes + ' notes, ' + snapshots + ' synthetic snapshots');
      const status = getById('pilot-lock-status');
      if (status) {
        status.textContent = store.readOnly ? (store.lockAvailable ? 'Read-only recovery mode' : 'Read-only, safe locking unavailable') : 'Local synthetic store ready';
        status.className = 'status-chip ' + (store.readOnly ? 'status-warn' : 'status-ok');
      }
      const seed = getById('seed-examples');
      if (seed) seed.disabled = store.readOnly;
      const importButton = getById('pilot-import-button');
      if (importButton) importButton.disabled = store.readOnly;
      if (submit) submit.disabled = store.readOnly;
    }

    function resetForm() {
      editing = null;
      draftConflict = false;
      if (form) form.reset();
      setText('note-form-title', 'New decision or assumption');
      if (submit) submit.textContent = 'Save note';
      if (cancel) cancel.hidden = true;
      if (reload) reload.hidden = true;
      if (snapshotSelect) snapshotSelect.disabled = false;
      if (reviewComment) reviewComment.value = '';
      setError(null, false);
      renderSnapshots();
    }

    function fillForm(note) {
      editing = note;
      draftConflict = false;
      if (form) form.reset();
      if (snapshotSelect) snapshotSelect.value = note.snapshotId;
      if (snapshotSelect) snapshotSelect.disabled = true;
      const setValue = (id, value) => { const node = getById(id); if (node) node.value = value == null ? '' : value; };
      setValue('note-category', note.category);
      setValue('note-type', note.decisionType);
      setValue('note-decision', note.decisionText);
      setValue('note-reason', note.reason);
      setValue('note-previous', note.previousValue);
      setValue('note-revised', note.revisedValue);
      setValue('note-evidence', note.evidenceRef);
      setText('note-form-title', 'Edit decision or assumption');
      if (submit) submit.textContent = 'Save revision';
      if (cancel) cancel.hidden = false;
      if (reload) reload.hidden = false;
      setError(null, false);
      renderSnapshots();
      const title = getById('note-form-title');
      if (title && title.scrollIntoView) title.scrollIntoView({ block: 'nearest' });
    }

    function renderSnapshots() {
      if (!snapshotSelect) return;
      const chosen = snapshotSelect.value;
      while (snapshotSelect.firstChild) snapshotSelect.removeChild(snapshotSelect.firstChild);
      const placeholder = domElement('option', '', 'Choose a matching snapshot');
      placeholder.value = '';
      snapshotSelect.appendChild(placeholder);
      const current = store.getState();
      (current ? current.snapshots : []).forEach(snapshot => {
        const option = domElement('option', '', snapshot.payload.id + ' · ' + snapshot.payload.date + ' · synthetic');
        option.value = snapshot.payload.id;
        snapshotSelect.appendChild(option);
      });
      snapshotSelect.value = chosen;
    }

    function badge(label, status) {
      const node = domElement('span', 'note-badge badge-' + status, label);
      node.setAttribute('aria-label', label);
      return node;
    }

    function renderHistory(note, container) {
      const details = domElement('details', 'note-history');
      const summary = domElement('summary', '', 'Revision history (' + note.history.length + ' prior)');
      details.appendChild(summary);
      if (!note.history.length) details.appendChild(domElement('p', 'hint', 'No prior revisions.'));
      note.history.slice().reverse().forEach(entry => {
        const row = domElement('div', 'history-row');
        row.appendChild(domElement('strong', '', 'Revision ' + entry.revision));
        row.appendChild(domElement('span', 'hint', formatTimestamp(entry.changedAt) + ' · immutable history'));
        row.appendChild(domElement('p', '', 'Decision: ' + entry.values.decisionText));
        row.appendChild(domElement('p', '', 'Reason: ' + entry.values.reason));
        row.appendChild(domElement('p', '', 'Previous: ' + (entry.values.previousValue === null ? 'Unknown or not supplied' : entry.values.previousValue)));
        row.appendChild(domElement('p', '', 'Revised: ' + (entry.values.revisedValue === null ? 'Unknown or not supplied' : entry.values.revisedValue)));
        row.appendChild(domElement('p', '', 'Evidence: ' + (entry.values.evidenceRef || 'Not supplied')));
        row.appendChild(domElement('p', '', 'Review: ' + (entry.values.review.status === 'reviewed' ? (entry.values.review.comment || 'Reviewed without a comment') : 'Needs review')));
        details.appendChild(row);
      });
      container.appendChild(details);
    }

    function renderNotes() {
      if (!noteList) return;
      while (noteList.firstChild) noteList.removeChild(noteList.firstChild);
      const current = store.getState();
      const notes = current ? current.notes : [];
      if (!notes.length) {
        const empty = domElement('div', 'empty-state');
        empty.appendChild(domElement('h3', '', 'No synthetic notes yet'));
        empty.appendChild(domElement('p', '', 'Create a note, or load the ten fixed examples to review cash, insurance and projection assumptions.'));
        noteList.appendChild(empty);
        return;
      }
      notes.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).forEach(note => {
        const status = store.snapshotStatus(note);
        const card = domElement('article', 'note-card');
        const head = domElement('div', 'note-card-head');
        const title = domElement('div', 'note-card-title');
        title.appendChild(domElement('strong', '', note.decisionText || '(No decision text)'));
        title.appendChild(domElement('span', 'hint', note.category + ' · ' + note.decisionType + ' · revision ' + note.revision));
        head.appendChild(title);
        const badges = domElement('div', 'note-badges');
        badges.appendChild(badge(status.label, status.status));
        badges.appendChild(badge(note.review.status === 'reviewed' ? 'Reviewed' : 'Needs review', note.review.status === 'reviewed' ? 'reviewed' : 'unreviewed'));
        head.appendChild(badges);
        card.appendChild(head);
        const body = domElement('div', 'note-card-body');
        body.appendChild(domElement('p', '', note.reason));
        const facts = domElement('dl', 'note-facts');
        [['Snapshot', note.snapshotId], ['Previous', note.previousValue === null ? 'Unknown or not supplied' : note.previousValue], ['Revised', note.revisedValue === null ? 'Unknown or not supplied' : note.revisedValue], ['Evidence', note.evidenceRef || 'Unverified reference not supplied'], ['Updated', formatTimestamp(note.updatedAt) + ' · synthetic local']].forEach(pair => {
          facts.appendChild(domElement('dt', '', pair[0]));
          facts.appendChild(domElement('dd', '', pair[1]));
        });
        body.appendChild(facts);
        if (status.status !== 'matching') body.appendChild(domElement('p', 'note-warning', status.status === 'missing' ? 'The original snapshot is unavailable. This note remains readable and its historical link is unchanged.' : 'The snapshot ID exists, but its schema version or hash differs. This note remains readable and is not rebound.'));
        if (note.review.status === 'reviewed') body.appendChild(domElement('p', 'review-copy', 'Review: ' + (note.review.comment || 'Reviewed without a comment')));
        const actions = domElement('div', 'note-card-actions');
        const edit = domElement('button', 'btn', 'Edit');
        edit.type = 'button';
        edit.disabled = store.readOnly;
        edit.addEventListener('click', () => fillForm(note));
        actions.appendChild(edit);
        if (note.review.status !== 'reviewed') {
          const review = domElement('button', 'btn btn-ghost', 'Review');
          review.type = 'button';
          review.disabled = store.readOnly;
          const reviewEditor = domElement('div', 'review-editor');
          reviewEditor.hidden = true;
          const reviewLabel = domElement('label', 'lbl', 'Review note');
          const reviewId = 'review-' + note.id;
          reviewLabel.htmlFor = reviewId;
          const reviewField = domElement('textarea', 'fi', '');
          reviewField.id = reviewId;
          reviewField.maxLength = 2000;
          reviewField.placeholder = 'What was checked, or what remains open?';
          reviewField.rows = 3;
          const reviewActions = domElement('div', 'note-card-actions');
          const recordReview = domElement('button', 'btn btn-primary', 'Record review');
          recordReview.type = 'button';
          const cancelReview = domElement('button', 'btn btn-ghost', 'Cancel');
          cancelReview.type = 'button';
          reviewActions.appendChild(recordReview);
          reviewActions.appendChild(cancelReview);
          reviewEditor.appendChild(reviewLabel);
          reviewEditor.appendChild(reviewField);
          reviewEditor.appendChild(reviewActions);
          review.addEventListener('click', () => {
            reviewEditor.hidden = false;
            review.hidden = true;
            reviewField.focus();
          });
          cancelReview.addEventListener('click', () => {
            reviewField.value = '';
            reviewEditor.hidden = true;
            review.hidden = false;
          });
          recordReview.addEventListener('click', async () => {
            if (!reviewField.value.trim()) {
              setError(pilotError('REQUIRED_TEXT', 'Add a short review note before recording the review.'), false);
              reviewField.focus();
              return;
            }
            recordReview.disabled = true;
            try { await store.reviewNote(note.id, { comment: reviewField.value }, note.revision, note.hash); setError(null, false); renderNotes(); updateStatus(); }
            catch (error) { recordReview.disabled = false; setError(error, error.code === 'NOTE_CONFLICT' || error.code === 'STORAGE_WRITE_FAILED'); }
          });
          actions.appendChild(review);
          body.appendChild(reviewEditor);
        }
        card.appendChild(actions);
        renderHistory(note, body);
        card.appendChild(body);
        noteList.appendChild(card);
      });
    }

    function formValues() {
      const value = id => { const node = getById(id); return node ? node.value : ''; };
      return { snapshotId: value('note-snapshot'), category: value('note-category'), decisionType: value('note-type'), decisionText: value('note-decision'), reason: value('note-reason'), previousValue: value('note-previous'), revisedValue: value('note-revised'), evidenceRef: value('note-evidence') };
    }

    if (form) form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving) return;
      saving = true;
      if (submit) submit.disabled = true;
      const values = formValues();
      try {
        if (editing) {
          const updated = await store.updateNote(editing.id, values, editing.revision, editing.hash);
          editing = updated;
          resetForm();
          setText('pilot-save-status', 'Revision saved locally with its prior revision retained.');
        } else {
          values.id = 'note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
          await store.createNote(values);
          resetForm();
          setText('pilot-save-status', 'Synthetic note saved locally.');
        }
        setError(null, false);
        renderNotes();
        updateStatus();
      } catch (error) {
        draftConflict = error.code === 'NOTE_CONFLICT';
        if (reload) reload.hidden = !draftConflict;
        setError(error, draftConflict || error.code === 'STORAGE_WRITE_FAILED' || error.code === 'RECOVERY_REQUIRED');
      } finally {
        saving = false;
        updateStatus();
      }
    });
    if (cancel) cancel.addEventListener('click', resetForm);
    const newNoteTop = getById('new-note-top');
    if (newNoteTop) newNoteTop.addEventListener('click', () => {
      resetForm();
      if (form && form.scrollIntoView) form.scrollIntoView({ block: 'start' });
      const first = getById('note-snapshot');
      if (first && !first.disabled && first.focus) first.focus();
    });
    if (reload) reload.addEventListener('click', () => {
      const current = store.getState();
      const note = current && editing ? current.notes.find(item => item.id === editing.id) : null;
      if (note) fillForm(note);
      else resetForm();
    });
    const seed = getById('seed-examples');
    if (seed) seed.addEventListener('click', async () => {
      try { await store.seedExamples(); setError(null, false); setText('pilot-save-status', 'Ten synthetic notes are ready for review.'); renderNotes(); updateStatus(); }
      catch (error) { setError(error, true); }
    });
    const exportButton = getById('pilot-export');
    if (exportButton) exportButton.addEventListener('click', async () => {
      try {
        const text = await store.exportJson();
        showExportPreview(text, 'export');
        downloadText('decision-notes-pilot.json', text);
        setError(null, false);
        setText('pilot-save-status', 'Export prepared below and download requested.');
      }
      catch (error) { setError(error, false); }
    });
    const exportRecovery = getById('pilot-export-recovery');
    if (exportRecovery) exportRecovery.addEventListener('click', () => {
      try {
        const text = store.exportRaw();
        showExportPreview(text, 'recovery');
        downloadText('decision-notes-pilot-recovery.json', text);
        setText('pilot-save-status', 'Raw recovery data prepared below and download requested.');
      }
      catch (error) { setError(error, false); }
    });
    const copyExport = getById('pilot-copy-export');
    if (copyExport) copyExport.addEventListener('click', async () => {
      const preview = getById('pilot-export-preview');
      if (!preview) return;
      try {
        if (!root.navigator || !root.navigator.clipboard || !root.navigator.clipboard.writeText) throw pilotError('COPY_UNAVAILABLE', 'Copy is unavailable here. Select the JSON text and copy it manually.');
        await root.navigator.clipboard.writeText(preview.value);
        setText('pilot-export-preview-status', 'JSON copied to the clipboard.');
      } catch (error) {
        setText('pilot-export-preview-status', error.message || 'Select the JSON text and copy it manually.');
      }
    });
    const importButton = getById('pilot-import-button');
    const importInput = getById('pilot-import-file');
    if (importButton && importInput) importButton.addEventListener('click', () => importInput.click());
    if (importInput) importInput.addEventListener('change', async () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return;
      if (file.size > MAX_IMPORT_BYTES) {
        setError(pilotError('IMPORT_TOO_LARGE', 'This export is larger than the 1 MB pilot limit.'), false);
        importInput.value = '';
        return;
      }
      try { await store.restore(await file.text()); setError(null, false); setText('pilot-save-status', 'Import merged without replacing newer or conflicting IDs.'); renderSnapshots(); renderNotes(); updateStatus(); }
      catch (error) { setError(error, true); }
      importInput.value = '';
    });
    const theme = getById('pilot-theme');
    if (theme) theme.addEventListener('click', () => {
      root.document.documentElement.classList.toggle('light');
      theme.setAttribute('aria-pressed', root.document.documentElement.classList.contains('light') ? 'true' : 'false');
    });
    if (root.addEventListener) root.addEventListener('storage', async event => {
      if (event.key !== STORAGE_KEY) return;
      try { await store.init(); renderSnapshots(); renderNotes(); updateStatus(); setText('pilot-save-status', 'Another tab changed the synthetic store.'); }
      catch (error) { setError(error, true); }
    });

    renderSnapshots();
    renderNotes();
    updateStatus();
    resetForm();
    if (store.recovery || store.storageError) setError(store.recovery || store.storageError, true);
    return store;
  }

  return {
    isNode,
    STORAGE_KEY,
    LOCK_NAME,
    FORMAT,
    EXPORT_SCHEMA_VERSION,
    NOTE_SCHEMA_VERSION,
    SOURCE_SCHEMA,
    SOURCE_SCHEMA_VERSION,
    CATEGORIES: CATEGORIES.slice(),
    DECISION_TYPES: DECISION_TYPES.slice(),
    SYNTHETIC_PAYLOADS: clone(SYNTHETIC_PAYLOADS),
    SYNTHETIC_NOTE_INPUTS: clone(SYNTHETIC_NOTE_INPUTS),
    allowedOrigin,
    formatTimestamp,
    canonicalJson,
    sha256Hex,
    hashSnapshot,
    hashNote,
    hashState,
    hashHistory,
    makeSnapshot,
    makeNote,
    syntheticSnapshots,
    syntheticDataset,
    initialState,
    validateSnapshot,
    validateNote,
    validateState,
    noteSnapshotStatus,
    exportEnvelope,
    parseImport,
    mergeState,
    createStore,
    startBrowser
  };
});
