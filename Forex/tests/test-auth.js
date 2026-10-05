// Synthetic Auth/config contract checks. No browser, network or stored values.
// The SDK is injected as a mock so the official supabase-js runtime is never
// fetched by this suite.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const configApi = require('../config.js');
const authApi = require('../lib/auth-client.js');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const previewSrc = fs.readFileSync(path.join(__dirname, 'auth-preview.html'), 'utf8');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  try { fn(); console.log('✅ PASS: ' + name); passed++; }
  catch (e) { console.error('❌ FAIL: ' + name); console.error(e); failed++; }
}
async function testAsync(name, fn) {
  const task = (async () => {
    try { await fn(); console.log('✅ PASS: ' + name); passed++; }
    catch (e) { console.error('❌ FAIL: ' + name); console.error(e); failed++; }
  })();
  pending.push(task);
}

function makeSdk(initialUser) {
  let user = initialUser || null;
  let session = user ? { access_token: 'synthetic-session-token', user } : null;
  const callbacks = new Set();
  const calls = [];
  const auth = {
    async getSession() { return { data: { session }, error: null }; },
    async getUser() { return { data: { user }, error: null }; },
    onAuthStateChange(callback) {
      callbacks.add(callback);
      return { data: { subscription: { unsubscribe() { callbacks.delete(callback); } } } };
    },
    async signInWithPassword(args) {
      calls.push({ type: 'password', email: args.email });
      user = { id: 'user-a', email: args.email };
      session = { access_token: 'synthetic-session-token', user };
      callbacks.forEach(cb => cb('SIGNED_IN', session));
      return { data: { user, session }, error: null };
    },
    async signUp(args) {
      calls.push({ type: 'register', email: args.email });
      user = { id: 'user-a', email: args.email };
      session = { access_token: 'synthetic-session-token', user };
      return { data: { user, session }, error: null };
    },
    async signInWithOAuth(args) {
      calls.push({ type: 'oauth', provider: args.provider, redirectTo: args.options.redirectTo });
      return { data: { provider: args.provider }, error: null };
    },
    async signOut(args) {
      calls.push({ type: 'signout', scope: args.scope });
      user = null; session = null;
      callbacks.forEach(cb => cb('SIGNED_OUT', null));
      return { error: null };
    }
  };
  return { createClient() { return { auth }; }, calls };
}

const hostedConfig = configApi.resolve({
  authEnabled: true,
  supabaseUrl: 'https://example.invalid',
  supabaseAnonKey: 'synthetic-public-key',
  authProviders: ['google']
}, { origin: 'https://app.example.invalid', pathname: '/Forex/' });

test('empty public config stays offline with local owner identity', () => {
  const cfg = configApi.resolve({}, { origin: 'http://localhost:48379' });
  assert.strictEqual(cfg.mode, 'offline');
  const auth = authApi.createAuthClient(cfg, { location: { origin: 'http://localhost:48379', pathname: '/Forex/' } });
  assert.deepStrictEqual(auth.currentUser(), { id: null, email: null, local: true });
});

test('public endpoints reject insecure remote origins and arbitrary callback origins', () => {
  const cfg = configApi.resolve({
    authEnabled: true,
    supabaseUrl: 'http://supabase.example.invalid',
    supabaseAnonKey: 'synthetic-public-key',
    authRedirectOrigin: 'https://other.example.invalid'
  }, { origin: 'https://app.example.invalid', pathname: '/Forex/' });
  assert.strictEqual(cfg.mode, 'broken');
  assert.ok(cfg.errors.some(error => /HTTPS/.test(error)));
  assert.ok(cfg.errors.some(error => /redirect origin/.test(error)));
});

test('billing Worker configuration requires one exact CSP origin', () => {
  const incomplete = configApi.resolve({
    authEnabled: true,
    supabaseUrl: 'https://example.invalid',
    supabaseAnonKey: 'synthetic-public-key',
    workerUrl: 'https://billing.example.invalid'
  }, { origin: 'https://app.example.invalid', pathname: '/Forex/' });
  assert.strictEqual(incomplete.mode, 'broken');
  assert.ok(incomplete.errors.some(error => /explicit Worker connect origin/.test(error)));
  const configured = configApi.resolve({
    authEnabled: true,
    supabaseUrl: 'https://example.invalid',
    supabaseAnonKey: 'synthetic-public-key',
    workerUrl: 'https://billing.example.invalid',
    workerConnectOrigin: 'https://billing.example.invalid'
  }, { origin: 'https://app.example.invalid', pathname: '/Forex/' });
  assert.strictEqual(configured.mode, 'hosted');
  assert.strictEqual(configured.workerConnectOrigin, 'https://billing.example.invalid');
});

testAsync('configured Auth without SDK is broken and never falls back to owner', async () => {
  const auth = authApi.createAuthClient(hostedConfig, { sdk: null, location: { origin: 'https://app.example.invalid', pathname: '/Forex/' } });
  await assert.rejects(() => auth.bootstrap(), /Auth client is unavailable|Hosted Auth is unavailable/);
  assert.strictEqual(auth.currentUser().local, false);
  assert.strictEqual(auth.currentUser().scope, 'hosted-anonymous');
});

testAsync('hosted signed-out bootstrap has no local owner and no session', async () => {
  const sdk = makeSdk(null);
  const auth = authApi.createAuthClient(hostedConfig, { sdk, location: { origin: 'https://app.example.invalid', pathname: '/Forex/' } });
  const user = await auth.bootstrap();
  assert.strictEqual(user.local, false);
  assert.strictEqual(user.authenticated, false);
  assert.strictEqual(user.id, null);
  await assert.rejects(() => auth.headers(), /authenticated session/);
});

testAsync('sign-in uses SDK session and sign-out requests local scope', async () => {
  const sdk = makeSdk(null);
  const auth = authApi.createAuthClient(hostedConfig, { sdk, location: { origin: 'https://app.example.invalid', pathname: '/Forex/' } });
  const signedIn = await auth.signInEmail('synthetic@example.invalid', 'synthetic-password');
  assert.strictEqual(signedIn.id, 'user-a');
  const headers = await auth.headers();
  assert.strictEqual(headers.Authorization, 'Bearer synthetic-session-token');
  await auth.signOut();
  assert.deepStrictEqual(sdk.calls.find(c => c.type === 'signout'), { type: 'signout', scope: 'local' });
  assert.strictEqual(auth.currentUser().local, false);
  assert.strictEqual(auth.currentUser().id, null);
});

testAsync('registration without a session stays pending and carries a safe callback URL', async () => {
  const sdk = makeSdk(null);
  const client = sdk.createClient();
  let signUpArgs;
  client.auth.signUp = async args => {
    signUpArgs = args;
    return { data: { user: { id: 'user-pending', email: args.email }, session: null }, error: null };
  };
  const auth = authApi.createAuthClient(hostedConfig, { sdk, location: { origin: 'https://app.example.invalid', pathname: '/Forex/' } });
  const result = await auth.registerEmail('synthetic@example.invalid', 'synthetic-password');
  assert.strictEqual(result.pendingConfirmation, true);
  assert.strictEqual(auth.currentUser().id, null);
  assert.strictEqual(signUpArgs.options.emailRedirectTo, 'https://app.example.invalid/Forex/');
});

testAsync('a stale A verification cannot commit after an SDK event switches to B', async () => {
  let resolveSession, resolveUser, getUserToken = '';
  const callbacks = new Set();
  const authApiMock = {
    async getSession() {
      return new Promise(resolve => { resolveSession = resolve; });
    },
    async getUser(token) {
      getUserToken = token;
      return new Promise(resolve => { resolveUser = resolve; });
    },
    onAuthStateChange(callback) {
      callbacks.add(callback);
      return { data: { subscription: { unsubscribe() { callbacks.delete(callback); } } } };
    }
  };
  const sdk = { createClient() { return { auth: authApiMock }; } };
  const auth = authApi.createAuthClient(hostedConfig, { sdk, location: { origin: 'https://app.example.invalid', pathname: '/Forex/' } });
  auth.onAuthStateChange(() => {});
  const boot = auth.bootstrap();
  resolveSession({ data: { session: { access_token: 'token-a', user: { id: 'user-a' } } }, error: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(getUserToken, 'token-a');
  callbacks.forEach(callback => callback('SIGNED_IN', { user: { id: 'user-b' } }));
  resolveUser({ data: { user: { id: 'user-a', email: 'a@example.invalid' } }, error: null });
  await assert.rejects(() => boot, /session changed/);
  assert.strictEqual(auth.currentUser().id, null);
});

testAsync('refresh verification failure stays hosted and does not become owner', async () => {
  const sdk = makeSdk({ id: 'user-a', email: 'synthetic@example.invalid' });
  const client = sdk.createClient();
  client.auth.getUser = async () => ({ data: { user: null }, error: { message: 'synthetic verification failure' } });
  const auth = authApi.createAuthClient(hostedConfig, { sdk, location: { origin: 'https://app.example.invalid', pathname: '/Forex/' } });
  await assert.rejects(() => auth.bootstrap(), /verification failure/);
  assert.strictEqual(auth.currentUser().local, false);
  assert.strictEqual(auth.currentUser().id, null);
});

testAsync('OAuth provider list and callback origin are constrained', async () => {
  const sdk = makeSdk(null);
  const auth = authApi.createAuthClient(hostedConfig, { sdk, location: { origin: 'https://app.example.invalid', pathname: '/Forex/' } });
  await auth.signInProvider('google');
  const call = sdk.calls.find(c => c.type === 'oauth');
  assert.strictEqual(call.provider, 'google');
  assert.strictEqual(call.redirectTo, 'https://app.example.invalid/Forex/');
  await assert.rejects(() => auth.signInProvider('unknown'), /provider is disabled/);
});

test('source keeps hosted storage separate and fences stale requests', () => {
  assert.match(indexSrc, /function storageKeyForScope\(scope\)\{ return scope==='local-owner' \? APP\.storageKey : APP\.storageKey\+'_'\+scope; \}/);
  assert.match(indexSrc, /function scopeIsCurrent\(s\)/);
  assert.match(indexSrc, /function isHostedBroken\(\)/);
  assert.match(indexSrc, /_activeScope\s*=\s*''/);
  assert.match(indexSrc, /setStorageScope\(FOREX_CONFIG\.mode==='offline'\?'local-owner':'hosted-anonymous'\)/);
  assert.match(indexSrc, /_authEpoch\+\+/);
  assert.match(indexSrc, /if\(!scopeIsCurrent\(snap\)\) return/);
  assert.match(indexSrc, /if\(isHostedMode\(\)&&!currentUser\(\)\.id\) return/);
  assert.match(indexSrc, /function getKey\(\)\{ return isLocalOwner\(\)/);
});

test('source keeps signed-out cloud reads disabled and preserves scoped queues', () => {
  assert.match(indexSrc, /async function loadData\(\)\{[\s\S]*?if\(isHostedMode\(\)&&!currentUser\(\)\.id\) return(?: null)?;/);
  assert.match(indexSrc, /captured\.key\+'_pendingdel'/);
  assert.match(indexSrc, /_queueDelete\(table,id,expectedUpdatedAt,data,snap\)/);
  assert.match(indexSrc, /_unqueueDelete\(table,id,snap\)/);
});

test('source uses active-row cap UX and leaves edits available', () => {
  assert.match(indexSrc, /async function canCreateTrade\(\)/);
  assert.match(indexSrc, /if\(!id\s*&&\s*!await canCreateTrade\(\)\) return;/);
  assert.match(indexSrc, /const cap=Number\(_accountState\.trade_cap\|\|FREE_TRADE_CAP\)/);
  assert.doesNotMatch(indexSrc, /async function openTradeModal\(id\)\{[\s\S]{0,180}requireEntitlement\('unlimited_trades'/);
});

test('source distinguishes server denial from unavailable hosted features', () => {
  assert.match(indexSrc, /const result=await sbRpc\('authorise_feature'/);
  assert.match(indexSrc, /if\(!allowed\)\{ toast\(/);
  assert.match(indexSrc, /catch\(e\)\{\s*if\(!scopeIsCurrent\(snap\)\) return false;\s*toast\('Could not verify/);
  assert.match(indexSrc, /sbRpc\('import_trades',\{p_rows\}/);
  assert.match(indexSrc, /Number\(result\.skipped_existing\)/);
  assert.match(indexSrc, /lib\/supabase-2\.117\.2\.umd\.js\?v=2\.117\.2/);
  assert.match(indexSrc, /integrity="sha384-Rj26LVGvoeRVR6\+mwQmFfcR3QOBEwT\+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok"/);
});

test('unconfigured account and billing controls stay disabled', () => {
  assert.match(indexSrc, /if\(isLocalOwner\(\)\) return '<div class="modal-body"><div class="warn">Local device mode is active/);
  assert.match(indexSrc, /const billingConfigured=_billingState\.configured===true/);
  assert.match(indexSrc, /const checkoutReady=billingAvailable&&_billingState\.checkout_available===true/);
  assert.match(indexSrc, /const portalReady=billingAvailable&&_billingState\.portal_enabled===true/);
  assert.match(indexSrc, /const historyReady=billingAvailable&&_billingState\.history_enabled===true/);
  assert.match(indexSrc, /const cancelReady=billingAvailable&&_billingState\.cancel_enabled===true/);
  assert.match(indexSrc, /Billing is not available in this preview/);
  assert.match(indexSrc, /Billing is temporarily unavailable\. Try again later/);
  assert.match(indexSrc, /async function billingRequest\(path,method,body,scope\)/);
  assert.match(indexSrc, /await billingRequest\('\/account','GET'/);
  assert.match(indexSrc, /await billingRequest\(kind==='checkout'\?'\/checkout':'\/portal','POST'/);
  assert.match(indexSrc, /operation_id:operationId/);
  assert.match(indexSrc, /kind==='manage'\?\{\}:\{action:kind\}/);
  assert.match(indexSrc, /billingAction\(\\'history\\'\)/);
  assert.match(indexSrc, /billingAction\(\\'cancel\\'\)/);
  assert.match(indexSrc, /checkout\.stripe\.com/);
  assert.match(indexSrc, /billing\.stripe\.com/);
  assert.match(indexSrc, /function safeBillingUrl\(value,kind\)/);
  assert.match(indexSrc, /const previousFocus=document\.activeElement/);
  assert.match(indexSrc, /_modalKeyTrap\.__previousFocus=previousFocus/);
  assert.match(indexSrc, /previous\.focus\(\)/);
  assert.match(indexSrc, /const plan=v\.plan==='pro'\?'pro':'free'/);
  assert.match(indexSrc, /Number\.isSafeInteger\(v\.trade_count\)/);
  assert.match(indexSrc, /source\[feature\]===true/);
  assert.match(indexSrc, /\.\/welcome\.html/);
  assert.match(indexSrc, /\.\/terms\.html/);
  assert.match(indexSrc, /\.\/privacy\.html/);
  assert.match(indexSrc, /\.\/refunds\.html/);
  assert.match(indexSrc, /Check your email to confirm your account/);
  assert.match(indexSrc, /if\(location\.hash==='#account'\) openAccountSettings\(\)/);
  assert.match(indexSrc, /location\.hash==='#signup'\) openAccountSettings\('signup'\)/);
  assert.match(indexSrc, /function accountModalHtml\(mode\)/);
  assert.match(indexSrc, /authMode==='signup'/);
  assert.match(indexSrc, /Create account/);
  assert.match(indexSrc, /history_enabled:raw\.history_enabled===true/);
  assert.match(indexSrc, /cancel_enabled:raw\.cancel_enabled===true/);
  assert.match(indexSrc, /let _billingError = ''/);
  assert.match(indexSrc, /function setBillingError\(message\)/);
  assert.match(indexSrc, /id="billing-error" role="alert" aria-live="polite"/);
  assert.match(indexSrc, /setBillingError\('Billing is temporarily unavailable\. Try again\.'\)/);
  assert.match(indexSrc, /\.account-email\{overflow-wrap:anywhere;word-break:break-word\}/);
  assert.match(indexSrc, /account-email/);
  assert.match(indexSrc, /const title=currentUser\(\)\.id\?'Account'/);
});

test('synthetic Auth preview rejects stale bytes and never touches host storage', () => {
  assert.match(previewSrc, /index\.html\?v=auth-preview-\' \+ Date\.now\(\)/);
  assert.match(previewSrc, /version\[1\] !== 'v0\.14 \(03 Oct\)'/);
  assert.match(previewSrc, /id="account-btn"/);
  assert.match(previewSrc, /Object\.defineProperty\(window, 'localStorage'/);
  assert.match(previewSrc, /Object\.defineProperty\(window, 'sessionStorage'/);
  assert.match(previewSrc, /const sdkTag = \/<script/);
  assert.match(previewSrc, /const isolatedSource = source\.replace\(sdkTag, ''\)/);
  assert.match(previewSrc, /function syntheticBootstrapScript\(origin\)/);
  assert.match(previewSrc, /workerConnectOrigin: origin/);
  assert.match(previewSrc, /const fixtureCsp = .*connect-src/);
  assert.match(previewSrc, /syntheticBootstrapScript\.toString\(\)/);
  assert.match(previewSrc, /JSON\.stringify\(location\.origin\)/);
  assert.match(previewSrc, /synthetic SDK, memory-only storage/);
  assert.match(previewSrc, /const rowsForActive = \(\) =>/);
  assert.match(previewSrc, /\/rest\/v1\/rpc\/sync_trade/);
  assert.match(previewSrc, /\/rest\/v1\/trades/);
  assert.match(previewSrc, /email: 'x{64}@example\.invalid'/);
  assert.match(previewSrc, /data-action="billing"/);
  assert.match(previewSrc, /data-action="route" data-value="signup"/);
  assert.match(previewSrc, /message\.action === 'route' && message\.value === 'signup'/);
  assert.match(previewSrc, /window\.location\.hash = '#signup'/);
  assert.match(previewSrc, /url === origin \+ '\/portal'/);
  assert.match(previewSrc, /event: 'BILLING_ACTION'/);
  assert.match(previewSrc, /active: active && active\.id, email: active && active\.email, plan/);
  assert.match(previewSrc, /reportBillingAction\(action, enabled \? 'controlled-503' : 'controlled-403'/);
  assert.match(previewSrc, /billingReceipt = event\.data\.event === 'BILLING_ACTION'/);
  assert.doesNotMatch(previewSrc, /localStorage\.getItem|localStorage\.setItem|localStorage\.removeItem/);
});

Promise.all(pending).then(() => {
  console.log(`--- Auth tests: ${passed} passed, ${failed} failed ---`);
  if (failed) process.exit(1);
});
