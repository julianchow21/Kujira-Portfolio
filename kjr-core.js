/* ═══════════════════════════════════════════════════════════════════════
   KUJIRA PORTFOLIO — kjr-core.js
   Pure, side-effect-free logic extracted from index.html so it can be unit
   tested under node with zero build step. Loaded by index.html via a plain
   <script src> (functions become globals); also require()-able from tests via
   the module.exports shim at the foot of the file.
   Keep this file PURE: no DOM, no localStorage, no fetch, no app globals.
   ═══════════════════════════════════════════════════════════════════════ */

/* True when a DB-shaped object holds any real financial data. Used to decide
   whether seeding an empty cloud sheet is safe (see seedDecision). Snapshots,
   changelog and trash are intentionally excluded — they can exist without the
   user having entered any holdings. */
function looksPopulated(db){
  if (!db || typeof db !== 'object') return false;
  var tables = ['stocks','crypto','realestate','cash','cpfHistory','income','expenses'];
  return tables.some(function(t){ return Array.isArray(db[t]) && db[t].length > 0; });
}

/* #Crit-1 seed-safety guard. boot() pulls the cloud sheet and, on first run,
   seeds an empty sheet from local. The danger: a SCHEMA version bump (or a
   malformed backend response) makes a POPULATED remote read as "wrong schema",
   and the old code would push the empty local DB over it — wiping the master
   record. This pure decision function closes that path.
     remoteData     parsed cloud response
     opts           { allowSeed } — true only on the boot pull
     expectedSchema the SCHEMA constant the client expects
   Returns:
     'ok'         schema matches — no seed branch, normal pull
     'seed'       remote is genuinely empty and seeding is allowed → safe
     'refuse'     remote holds data under an unexpected schema → NEVER overwrite
     'push-first' remote empty but not in seed mode → caller shows "Push first"
*/
function seedDecision(remoteData, opts, expectedSchema){
  if (remoteData && remoteData.schema === expectedSchema) return 'ok';
  if (looksPopulated(remoteData)) return 'refuse';
  if (opts && opts.allowSeed) return 'seed';
  return 'push-first';
}

/* node/test shim — harmless in the browser (no `module` global there). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { looksPopulated, seedDecision };
}
