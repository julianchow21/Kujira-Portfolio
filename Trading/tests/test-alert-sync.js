// Trading v-tests: fake-only regression suite for dashboard-to-Worker alert
// mutation ordering. It extracts the shipped functions from index.html and
// supplies deterministic timer/fetch fakes; no browser, Worker, or Telegram
// service is contacted.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC_PATH = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(SRC_PATH, 'utf8');

function sliceFromMatch(source, start) {
  let i = source.indexOf('(', start);
  let depth = 1; i++;
  while (depth > 0) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
    i++;
  }
  while (source[i] !== '{') i++;
  let braces = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') braces++;
    else if (source[i] === '}') { braces--; if (!braces) { i++; break; } }
  }
  return source.slice(start, i);
}
function extractFunction(name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('missing function ' + name);
  const start = src.slice(Math.max(0, m.index - 6), m.index) === 'async ' ? m.index - 6 : m.index;
  return sliceFromMatch(src, start);
}

const names = [
  'remoteConfigSnapshot', 'remoteConfigCanWrite', 'cancelPendingAlertSync',
  'queueRemoteMutation', 'autoSyncAlerts', 'disableRemoteAlerts',
  'handleRemoteSettingsChange', 'retryRemoteDisable',
];
const code = [
  `var SYMBOL='MU';
   var cfg={proxyMode:'worker',proxyUrl:'https://worker.test',tgEnabled:true,tgChatId:'old-chat',alertsSecret:'old-secret'};
   var alerts=[{id:'one',type:'price_above',value:100,oneShot:false,cooldownMs:0,enabled:true,armed:true,prevCond:null,lastFiredAt:null}];
   var _tgSyncDebounce=null, _tgRemoteGeneration=0, _tgRemoteQueue=Promise.resolve();
   var __timers=new Map(), __nextTimer=0;
   function setTimeout(fn){ const id=++__nextTimer; __timers.set(id,fn); return id; }
   function clearTimeout(id){ __timers.delete(id); }
   var __fetchCalls=[], __fetchResolvers=[];
   function fetch(url,init){ __fetchCalls.push({url,init}); return new Promise(resolve=>__fetchResolvers.push(resolve)); }
   function saveCfg(){}
   function renderAlertBarTgChip(){}
   function isLocalhostPreview(){ return false; }
  `,
  ...names.map(extractFunction),
].join('\n');

const sandbox = {};
vm.runInContext(code, vm.createContext(sandbox), { filename: 'extracted-alert-sync.js' });

function tick() { return new Promise(resolve => setImmediate(resolve)); }
function body(call) { return JSON.parse(call.init.body); }

(async () => {
  // A pending enabled sync must be cancelled as soon as push is turned off,
  // even though autoSyncAlerts returns through its disabled-settings guard.
  sandbox.autoSyncAlerts();
  assert.strictEqual(sandbox.__timers.size, 1);
  sandbox.cfg.tgEnabled = false;
  sandbox.autoSyncAlerts();
  assert.strictEqual(sandbox.__timers.size, 0, 'push-off must cancel a pending enabled timer');

  // Start an enabled POST, then turn push off while the request is unresolved.
  // The disable must wait behind the in-flight POST and be the final mutation.
  sandbox.cfg.tgEnabled = true;
  sandbox.autoSyncAlerts();
  const timer = [...sandbox.__timers.values()][0];
  timer();
  await tick();
  assert.strictEqual(sandbox.__fetchCalls.length, 1);
  assert.strictEqual(body(sandbox.__fetchCalls[0]).enabled, true);

  const previous = sandbox.remoteConfigSnapshot();
  sandbox.cfg.tgEnabled = false;
  const disablePromise = sandbox.handleRemoteSettingsChange(previous);
  await tick();
  assert.strictEqual(sandbox.__fetchCalls.length, 1, 'disable must queue behind the in-flight enable');

  sandbox.__fetchResolvers.shift()({ ok: true, json: async () => ({ ok: true, enabled: true }) });
  await tick(); await tick();
  assert.strictEqual(sandbox.__fetchCalls.length, 2, 'queued disable should start after enable settles');
  assert.strictEqual(body(sandbox.__fetchCalls[1]).enabled, false);
  assert.strictEqual(body(sandbox.__fetchCalls[1]).chatId, 'old-chat');

  sandbox.__fetchResolvers.shift()({ ok: true, json: async () => ({ ok: true, enabled: false }) });
  const result = await disablePromise;
  assert.strictEqual(result.ok, true);
  assert.strictEqual(sandbox.cfg.tgDisableRecovery, undefined);

  // A failed acknowledgement must retain the old endpoint/secret and let the
  // user retry it after connectivity returns.
  sandbox.cfg.tgEnabled = true;
  sandbox.cfg.tgChatId = 'old-chat';
  sandbox.cfg.alertsSecret = 'old-secret';
  const previousRetry = sandbox.remoteConfigSnapshot();
  sandbox.cfg.tgEnabled = false;
  const failedDisable = sandbox.handleRemoteSettingsChange(previousRetry);
  await tick();
  sandbox.__fetchResolvers.shift()({ ok: false, json: async () => ({ ok: false }) });
  const failedResult = await failedDisable;
  assert.strictEqual(failedResult.ok, false);
  assert.strictEqual(sandbox.cfg.tgDisableRecovery.tgChatId, 'old-chat');
  const retry = sandbox.retryRemoteDisable();
  await tick();
  sandbox.__fetchResolvers.shift()({ ok: true, json: async () => ({ ok: true, enabled: false }) });
  assert.strictEqual((await retry).ok, true);
  assert.strictEqual(sandbox.cfg.tgDisableRecovery, undefined);

  // Re-enabling with a new destination must clear any still-pending old route
  // before a new enabled:true sync is allowed to start.
  sandbox.cfg.tgDisableRecovery = { proxyMode: 'worker', proxyUrl: 'https://worker.test', tgEnabled: true, tgChatId: 'old-chat', alertsSecret: 'old-secret' };
  sandbox.cfg.tgEnabled = true;
  sandbox.cfg.tgChatId = 'new-chat';
  const reenable = sandbox.handleRemoteSettingsChange({ proxyMode: 'worker', proxyUrl: 'https://worker.test', tgEnabled: false, tgChatId: 'new-chat', alertsSecret: 'old-secret' });
  await tick();
  assert.strictEqual(sandbox.__fetchCalls.length, 5, 're-enable must retry the old disable before enabling the new route');
  assert.strictEqual(body(sandbox.__fetchCalls[4]).enabled, false);
  assert.strictEqual(body(sandbox.__fetchCalls[4]).chatId, 'old-chat');
  sandbox.__fetchResolvers.shift()({ ok: true, json: async () => ({ ok: true, enabled: false }) });
  assert.strictEqual((await reenable).ok, true);
  assert.strictEqual(sandbox.cfg.tgDisableRecovery, undefined);
  console.log('✅ PASS: remote alert mutations cancel stale timers and serialize disable after enable');
})().catch(err => { console.error('❌ FAIL: remote alert mutation race'); console.error(err); process.exitCode = 1; });
