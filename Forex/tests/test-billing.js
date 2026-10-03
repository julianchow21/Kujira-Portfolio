// Synthetic contract tests for the Forex Stripe Worker.
// No account, credential, Stripe or Supabase network is used. Every provider
// response is returned by the local fetch stub below.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const { TextEncoder, TextDecoder } = require('util');

const WORKER_PATH = path.join(__dirname, '..', 'Worker', 'Stripe Webhook Worker v0 (1 Aug).js');
const source = fs.readFileSync(WORKER_PATH, 'utf8');
const workerCode = source.replace('export default {', 'const workerDefault = {')
  + '\nthis.workerDefault = workerDefault;\n';
const context = vm.createContext({
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  Request,
  Response,
  Date,
  console,
});
vm.runInContext(workerCode, context, { filename: WORKER_PATH });

const USER_ID = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://forex.synthetic.test';
const SB_URL = 'https://forex-synthetic-project.supabase.co';
const PRICE_ID = 'price_test_synthetic';
const PRODUCT_ID = 'prod_test_synthetic';
const CUSTOMER_ID = 'cus_test_synthetic';
const SUBSCRIPTION_ID = 'sub_test_synthetic';
const SESSION_ID = 'cs_test_synthetic';
const PORTAL_CONFIGURATION_ID = 'bpc_testsynthetic';
const NOW = Math.floor(Date.now() / 1000);

const BASE_ENV = Object.freeze({
  STRIPE_BILLING_ENABLED: 'true',
  STRIPE_PRO_PRICE_ID: PRICE_ID,
  STRIPE_PRO_PRODUCT_ID: PRODUCT_ID,
  STRIPE_SECRET_KEY: 'sk_test_synthetic',
  STRIPE_WEBHOOK_SECRET: 'whsec_synthetic',
  STRIPE_API_VERSION: '2026-09-30.endive',
  STRIPE_SUCCESS_URL: `${ORIGIN}/Forex/?billing=success`,
  STRIPE_CANCEL_URL: `${ORIGIN}/Forex/?billing=cancel`,
  STRIPE_PORTAL_RETURN_URL: `${ORIGIN}/Forex/settings`,
  BILLING_ALLOWED_ORIGINS: ORIGIN,
  SB_URL,
  SB_PUBLISHABLE_KEY: 'sb_publishable_synthetic',
  SB_SERVICE_ROLE_KEY: 'service-role-synthetic',
});
const PORTAL_ENV = Object.freeze({
  ...BASE_ENV,
  STRIPE_PORTAL_CONFIGURATION_ID: PORTAL_CONFIGURATION_ID,
});

function response(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function checkoutIntent(userId, operationId) {
  return `${userId}:${operationId}`;
}

function checkoutKey(userId, operationId) {
  return `checkout-${userId}-${operationId}`;
}

function profile(plan = 'free', customerId = null, subscriptionId = null, userId = USER_ID) {
  return [{ id: userId, plan, stripe_customer_id: customerId, stripe_subscription_id: subscriptionId }];
}

function accountRow(plan = 'free', billingStatus) {
  const row = {
    plan,
    trade_count: plan === 'pro' ? 51 : 2,
    trade_cap: plan === 'pro' ? null : 50,
    entitlements: Object.fromEntries([
      'unlimited_trades', 'simulator', 'advanced_analytics',
      'ai_coach', 'chart_markers', 'csv_import',
    ].map((key) => [key, plan === 'pro'])),
  };
  if (billingStatus !== undefined) row.billing_status = billingStatus;
  return [row];
}

function priceItem() {
  return { price: { id: PRICE_ID, type: 'recurring', product: PRODUCT_ID } };
}

function checkoutEvent(id = 'evt_checkout', overrides = {}) {
  return {
    id,
    created: NOW,
    type: 'checkout.session.completed',
    data: { object: {
      id: SESSION_ID,
      mode: 'subscription',
      payment_status: 'paid',
      subscription: SUBSCRIPTION_ID,
      customer: CUSTOMER_ID,
      livemode: false,
      ...overrides,
    } },
  };
}

function subscriptionEvent(id = 'evt_subscription', overrides = {}, eventType = 'customer.subscription.updated') {
  return {
    id,
    created: NOW,
    type: eventType,
    data: { object: {
      id: SUBSCRIPTION_ID,
      customer: CUSTOMER_ID,
      status: 'active',
      livemode: false,
      items: { data: [priceItem()] },
      ...overrides,
    } },
  };
}

async function signature(raw, timestamp = String(NOW)) {
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(BASE_ENV.STRIPE_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = await webcrypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`),
  );
  return `t=${timestamp},v1=${Buffer.from(new Uint8Array(bytes)).toString('hex')}`;
}

function apiRequest(pathname, method, body, token = 'access.synthetic') {
  const init = {
    method,
    headers: {
      Origin: ORIGIN,
      Authorization: `Bearer ${token}`,
    },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request(`https://billing.synthetic.test${pathname}`, init);
}

async function webhookRequest(event, rawBody = JSON.stringify(event), timestamp = String(NOW)) {
  return new Request('https://billing.synthetic.test/webhook', {
    method: 'POST',
    headers: { 'Stripe-Signature': await signature(rawBody, timestamp) },
    body: rawBody,
  });
}

function createHarness(options = {}) {
  const calls = [];
  const userId = options.userId || USER_ID;
  const operationId = options.operationId || 'op_test_12345';
  const state = {
    profile: options.profile || profile('free', null, null, userId),
    begin: options.begin || [{
      accepted: true, existing: false, intent_id: checkoutIntent(userId, operationId), session_id: null,
      customer_id: null, idempotency_key: checkoutKey(userId, operationId), status: 'pending', reason: 'started',
    }],
    bind: options.bind || [{ bound: true, duplicate: false, matched: 1, reason: 'bound' }],
    record: options.record || [{ recorded: true, duplicate: false, reason: 'recorded' }],
    expire: options.expire || [{ expired: true, duplicate: false, reason: 'expired' }],
    complete: options.complete || [{ applied: true, duplicate: false, matched: 1, reason: 'applied' }],
    account: options.account || accountRow('free'),
    stripeSession: options.stripeSession || {
      id: SESSION_ID, url: 'https://checkout.stripe.com/cs_test_synthetic', customer: CUSTOMER_ID,
      subscription: SUBSCRIPTION_ID, mode: 'subscription', status: 'complete', payment_status: 'paid', livemode: false,
      line_items: { data: [priceItem()] },
    },
    stripeSubscription: options.stripeSubscription || {
      id: SUBSCRIPTION_ID, customer: CUSTOMER_ID, status: 'active', livemode: false,
      items: { data: [priceItem()] },
    },
    stripePortal: options.stripePortal || { id: 'bps_test', customer: CUSTOMER_ID, configuration: PORTAL_CONFIGURATION_ID, url: 'https://billing.stripe.com/p/session_test', livemode: false },
    portalConfig: options.portalConfig || {
      id: PORTAL_CONFIGURATION_ID,
      object: 'billing_portal.configuration',
      active: true,
      livemode: false,
      features: {
        invoice_history: { enabled: true },
        subscription_cancel: { enabled: true },
      },
    },
  };
  let fail;
  context.fetch = async (url, requestOptions = {}) => {
    const parsed = new URL(url);
    const method = requestOptions.method || 'GET';
    calls.push({ url, method, headers: requestOptions.headers || {}, body: requestOptions.body || '' });
    if (fail) throw fail;
    if (options.fetchOverride) {
      const overridden = await options.fetchOverride(url, requestOptions, state);
      if (overridden) return overridden;
    }
    if (parsed.pathname === '/auth/v1/user') return response({ id: userId, email: 'synthetic@example.test' });
    if (parsed.pathname === '/rest/v1/profiles') return response(state.profile);
    if (parsed.pathname === '/rest/v1/rpc/get_account_state') return response(state.account);
    if (parsed.pathname === '/rest/v1/rpc/authorise_feature') return response([{ allowed: true, feature: 'simulator', plan: 'pro', reason: 'allowed' }]);
    if (parsed.pathname === '/rest/v1/rpc/begin_stripe_checkout') return response(state.begin);
    if (parsed.pathname === '/rest/v1/rpc/bind_stripe_customer') return response(state.bind);
    if (parsed.pathname === '/rest/v1/rpc/record_stripe_checkout') return response(state.record);
    if (parsed.pathname === '/rest/v1/rpc/expire_stripe_checkout') return response(state.expire);
    if (parsed.pathname === '/rest/v1/rpc/complete_stripe_checkout') return response(state.complete);
    if (parsed.pathname === '/rest/v1/rpc/apply_stripe_event') return response(options.apply || [{ applied: true, duplicate: false, matched: 1, reason: 'applied' }]);
    if (parsed.pathname === '/v1/customers') return response({ id: CUSTOMER_ID, livemode: false });
    if (parsed.pathname === '/v1/checkout/sessions') return response(state.stripeSession);
    if (parsed.pathname === `/v1/checkout/sessions/${SESSION_ID}`) return response(state.stripeSession);
    if (parsed.pathname === `/v1/subscriptions/${SUBSCRIPTION_ID}`) return response(state.stripeSubscription);
    if (parsed.pathname === `/v1/billing_portal/configurations/${PORTAL_CONFIGURATION_ID}`) return response(state.portalConfig);
    if (parsed.pathname === '/v1/billing_portal/sessions') return response(state.stripePortal);
    return response({ error: 'unexpected synthetic provider route' }, 500);
  };
  return {
    calls,
    state,
    failWith(error) { fail = error; },
    async run(request, env = BASE_ENV) { return context.workerDefault.fetch(request, env); },
  };
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  let logLeak = false;
  console.log = (...args) => { if (args.join(' ').includes('sk_test_') || args.join(' ').includes('access.synthetic')) logLeak = true; originalLog(...args); };
  console.error = (...args) => { if (args.join(' ').includes('sk_test_') || args.join(' ').includes('access.synthetic')) logLeak = true; originalError(...args); };

  await test('rejects missing and invalid bearer tokens', async () => {
    const harness = createHarness();
    let out = await harness.run(apiRequest('/account', 'GET', undefined, ''));
    assert.strictEqual(out.status, 401);
    out = await harness.run(apiRequest('/account', 'GET', undefined, 'bad token'));
    assert.strictEqual(out.status, 401);
  });

  await test('rejects origin mismatch before provider calls', async () => {
    const harness = createHarness();
    const request = new Request('https://billing.synthetic.test/account', {
      method: 'GET',
      headers: { Origin: 'https://evil.synthetic.test', Authorization: 'Bearer access.synthetic' },
    });
    const out = await harness.run(request);
    assert.strictEqual(out.status, 403);
    assert.strictEqual(harness.calls.length, 0);
  });

  await test('rejects client price and customer injection with a strict body shape', async () => {
    const harness = createHarness();
    const out = await harness.run(apiRequest('/checkout', 'POST', {
      operation_id: 'op_test_12345', price_id: 'price_attacker', customer: 'cus_attacker',
    }));
    assert.strictEqual(out.status, 400);
    assert.strictEqual(harness.calls.filter((call) => call.url.includes('api.stripe.com') || call.url.includes('stripe.synthetic')).length, 0);
  });

  await test('keeps Checkout disabled by default and rejects live-mode keys', async () => {
    const disabled = { ...BASE_ENV, STRIPE_BILLING_ENABLED: 'false' };
    const disabledHarness = createHarness();
    let out = await disabledHarness.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_12345' }), disabled);
    assert.strictEqual(out.status, 503);
    out = await disabledHarness.run(apiRequest('/account', 'GET'), disabled);
    assert.strictEqual(out.status, 200);
    assert.strictEqual((await out.json()).billing_enabled, false);
    const liveHarness = createHarness();
    out = await liveHarness.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_12345' }), {
      ...BASE_ENV, STRIPE_SECRET_KEY: 'sk_live_synthetic',
    });
    assert.strictEqual(out.status, 503);
    assert.strictEqual(liveHarness.calls.filter((call) => call.url.includes('api.stripe.com') || call.url.includes('stripe.synthetic')).length, 0);
  });

  await test('keeps account history available but fails Checkout closed when the webhook secret is absent', async () => {
    const env = { ...BASE_ENV, STRIPE_WEBHOOK_SECRET: '' };
    const harness = createHarness();
    let out = await harness.run(apiRequest('/checkout', 'POST', { operation_id: 'op_missing_webhook' }), env);
    assert.strictEqual(out.status, 503);
    assert.strictEqual((await out.json()).code, 'checkout_unavailable');
    assert.strictEqual(harness.calls.some((call) => call.url.endsWith('/v1/checkout/sessions')), false);
    out = await harness.run(apiRequest('/account', 'GET'), env);
    assert.strictEqual(out.status, 200);
    const account = await out.json();
    assert.strictEqual(account.billing_enabled, true);
    assert.strictEqual(account.checkout_available, false);
    assert.strictEqual(account.billing_status, 'unknown');
  });

  await test('rejects invalid Supabase URLs before bearer or service requests', async () => {
    for (const value of [
      'https://attacker.synthetic.test',
      `${SB_URL}/path`,
      `https://user:pass@${new URL(SB_URL).hostname}`,
      'http://forex-synthetic-project.supabase.co',
    ]) {
      const harness = createHarness();
      const out = await harness.run(apiRequest('/account', 'GET'), { ...BASE_ENV, SB_URL: value });
      assert.strictEqual(out.status, 503);
      assert.strictEqual(harness.calls.length, 0);
    }
    const webhookHarness = createHarness();
    const webhookOut = await webhookHarness.run(
      await webhookRequest(subscriptionEvent('evt_invalid_supabase_url')),
      { ...BASE_ENV, SB_URL: 'https://attacker.synthetic.test' },
    );
    assert.strictEqual(webhookOut.status, 503);
    assert.strictEqual(webhookHarness.calls.some((call) => call.url.endsWith('/rpc/apply_stripe_event')), false);
  });

  await test('rejects remote HTTP origins but permits localhost HTTP preview origins', async () => {
    const remote = createHarness();
    const remoteRequest = new Request('https://billing.synthetic.test/account', {
      method: 'GET',
      headers: { Origin: 'http://preview.synthetic.test', Authorization: 'Bearer access.synthetic' },
    });
    let out = await remote.run(remoteRequest, { ...BASE_ENV, BILLING_ALLOWED_ORIGINS: 'http://preview.synthetic.test' });
    assert.strictEqual(out.status, 403);
    assert.strictEqual(remote.calls.length, 0);

    const local = createHarness();
    const localRequest = new Request('https://billing.synthetic.test/account', {
      method: 'GET',
      headers: { Origin: 'http://localhost:8787', Authorization: 'Bearer access.synthetic' },
    });
    out = await local.run(localRequest, { ...BASE_ENV, BILLING_ALLOWED_ORIGINS: 'http://localhost:8787' });
    assert.strictEqual(out.status, 200);
    assert.strictEqual((await out.json()).billing_enabled, false);
  });

  await test('pins Stripe requests to the official API origin unless explicit valid test injection is enabled', async () => {
    const pinned = createHarness();
    let out = await pinned.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_12345' }), {
      ...BASE_ENV,
      STRIPE_API_BASE_URL: 'https://attacker.synthetic.test',
    });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(pinned.calls.some((call) => call.url.startsWith('https://api.stripe.com/')), true);
    const invalid = createHarness();
    out = await invalid.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_12345' }), {
      ...BASE_ENV,
      STRIPE_TEST_INJECTION: 'true',
      STRIPE_TEST_API_BASE_URL: 'https://attacker.synthetic.test/path',
    });
    assert.strictEqual(out.status, 503);
    assert.strictEqual(invalid.calls.some((call) => new URL(call.url).hostname !== new URL(SB_URL).hostname), false);
  });

  await test('requires a server-owned Stripe test key before subscription events can change entitlement', async () => {
    const harness = createHarness();
    const out = await harness.run(
      await webhookRequest(subscriptionEvent('evt_no_server_key')),
      { ...BASE_ENV, STRIPE_SECRET_KEY: '' },
    );
    assert.strictEqual(out.status, 503);
    assert.strictEqual(harness.calls.some((call) => call.url.endsWith('/rpc/apply_stripe_event')), false);
  });

  await test('creates a test customer, proves the binding, records the session, and returns the fixed session URL', async () => {
    const harness = createHarness();
    const out = await harness.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_12345' }));
    assert.strictEqual(out.status, 200);
    const payload = await out.json();
    assert.deepStrictEqual(payload, { checkout_url: 'https://checkout.stripe.com/cs_test_synthetic', session_id: SESSION_ID });
    const create = harness.calls.find((call) => call.url.endsWith('/v1/checkout/sessions'));
    assert.ok(create);
    const form = new URLSearchParams(create.body);
    assert.strictEqual(form.get('line_items[0][price]'), PRICE_ID);
    assert.strictEqual(form.get('customer'), CUSTOMER_ID);
    assert.strictEqual(form.get('mode'), 'subscription');
    assert.strictEqual(form.get('success_url'), BASE_ENV.STRIPE_SUCCESS_URL);
    assert.strictEqual(form.get('cancel_url'), BASE_ENV.STRIPE_CANCEL_URL);
    const badUrl = createHarness({ operationId: 'op_test_badurl', stripeSession: { ...harness.state.stripeSession, url: 'https://evil.synthetic.test/checkout' } });
    const badOut = await badUrl.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_badurl' }));
    assert.strictEqual(badOut.status, 503);
    assert.strictEqual((await badOut.json()).code, 'checkout_create_failed');
    const paymentLinkHost = createHarness({ operationId: 'op_test_payment_link_host', stripeSession: {
      ...harness.state.stripeSession,
      url: 'https://buy.stripe.com/test_synthetic',
    } });
    const paymentLinkOut = await paymentLinkHost.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_payment_link_host' }));
    assert.strictEqual(paymentLinkOut.status, 503);
    assert.strictEqual((await paymentLinkOut.json()).code, 'checkout_create_failed');
    const fragment = createHarness({ operationId: 'op_test_fragment', stripeSession: {
      ...harness.state.stripeSession,
      url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic#fid_synthetic',
    } });
    const fragmentOut = await fragment.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_fragment' }));
    assert.strictEqual(fragmentOut.status, 200);
    assert.strictEqual((await fragmentOut.json()).checkout_url, 'https://checkout.stripe.com/c/pay/cs_test_synthetic#fid_synthetic');
  });

  await test('reuses the stored session on a duplicate operation without creating another session', async () => {
    const harness = createHarness({
      profile: profile('free', CUSTOMER_ID),
      begin: [{ accepted: true, existing: true, intent_id: checkoutIntent(USER_ID, 'op_test_12345'), session_id: SESSION_ID,
        customer_id: CUSTOMER_ID, idempotency_key: checkoutKey(USER_ID, 'op_test_12345'), status: 'created', reason: 'existing checkout' }],
    });
    const out = await harness.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_12345' }));
    assert.strictEqual(out.status, 200);
    assert.strictEqual((await out.json()).session_id, SESSION_ID);
    assert.strictEqual(harness.calls.filter((call) => call.method === 'GET' && call.url.includes('/v1/checkout/sessions/')).length, 1);
  });

  await test('reopens an earlier same-user checkout from a different operation and rejects a foreign intent prefix', async () => {
    const priorOperation = 'op_prior_123';
    const requestedOperation = 'op_new_1234';
    const reopen = createHarness({
      operationId: requestedOperation,
      profile: profile('free', CUSTOMER_ID),
      begin: [{ accepted: true, existing: true, intent_id: checkoutIntent(USER_ID, priorOperation), session_id: SESSION_ID,
        customer_id: CUSTOMER_ID, idempotency_key: checkoutKey(USER_ID, priorOperation), status: 'created', reason: 'existing checkout' }],
    });
    const reopened = await reopen.run(apiRequest('/checkout', 'POST', { operation_id: requestedOperation }));
    assert.strictEqual(reopened.status, 200);
    const begin = reopen.calls.find((call) => call.url.endsWith('/rpc/begin_stripe_checkout'));
    assert.strictEqual(JSON.parse(begin.body).p_intent_id, checkoutIntent(USER_ID, requestedOperation));
    assert.strictEqual(reopen.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/v1/checkout/sessions')).length, 0);

    const foreign = createHarness({
      operationId: requestedOperation,
      profile: profile('free', CUSTOMER_ID),
      begin: [{ accepted: true, existing: true, intent_id: checkoutIntent(USER_B, priorOperation), session_id: SESSION_ID,
        customer_id: CUSTOMER_ID, idempotency_key: checkoutKey(USER_B, priorOperation), status: 'created', reason: 'existing checkout' }],
    });
    const foreignOut = await foreign.run(apiRequest('/checkout', 'POST', { operation_id: requestedOperation }));
    assert.strictEqual(foreignOut.status, 503);
    assert.strictEqual((await foreignOut.json()).code, 'checkout_reservation_failed');
  });

  await test('releases an expired stored Checkout only after Stripe proves expiry', async () => {
    const harness = createHarness({
      profile: profile('free', CUSTOMER_ID),
      begin: [{ accepted: true, existing: true, intent_id: checkoutIntent(USER_ID, 'op_test_12345'), session_id: SESSION_ID,
        customer_id: CUSTOMER_ID, idempotency_key: checkoutKey(USER_ID, 'op_test_12345'), status: 'created', reason: 'existing checkout' }],
      stripeSession: {
        id: SESSION_ID, url: 'https://checkout.stripe.com/cs_test_synthetic', customer: CUSTOMER_ID,
        subscription: null, mode: 'subscription', status: 'expired', payment_status: 'unpaid', livemode: false,
      },
    });
    const out = await harness.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_12345' }));
    assert.strictEqual(out.status, 409);
    assert.strictEqual((await out.json()).code, 'checkout_expired');
    assert.strictEqual(harness.calls.filter((call) => call.url.endsWith('/rpc/expire_stripe_checkout')).length, 1);
    assert.strictEqual(harness.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/v1/checkout/sessions')).length, 0);
  });

  await test('rejects a stored subscription whose current Stripe customer does not match the profile', async () => {
    const harness = createHarness({
      operationId: 'op_bound_123',
      profile: profile('free', CUSTOMER_ID, SUBSCRIPTION_ID),
      stripeSubscription: {
        id: SUBSCRIPTION_ID, customer: 'cus_other', status: 'canceled', livemode: false,
        items: { data: [priceItem()] },
      },
    });
    const out = await harness.run(apiRequest('/checkout', 'POST', { operation_id: 'op_bound_123' }));
    assert.strictEqual(out.status, 503);
    assert.strictEqual((await out.json()).code, 'subscription_binding_failed');
    assert.strictEqual(harness.calls.some((call) => call.url.endsWith('/rpc/begin_stripe_checkout')), false);
  });

  await test('fails closed when customer binding fails', async () => {
    const harness = createHarness({ bind: [{ bound: false, duplicate: false, matched: 1, reason: 'customer already bound' }] });
    const out = await harness.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_12345' }));
    assert.strictEqual(out.status, 409);
    assert.strictEqual(harness.calls.filter((call) => call.url.endsWith('/v1/checkout/sessions')).length, 0);
  });

  await test('serialises concurrent checkout retries through one stored intent', async () => {
    let beginCalls = 0;
    const harness = createHarness({
      fetchOverride: async (url, options, state) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/rpc/begin_stripe_checkout')) {
          beginCalls += 1;
          if (beginCalls === 1) return response([{ accepted: true, existing: false, intent_id: checkoutIntent(USER_ID, 'op_test_12345'), session_id: null, customer_id: CUSTOMER_ID, idempotency_key: checkoutKey(USER_ID, 'op_test_12345'), status: 'pending', reason: 'started' }]);
          return response([{ accepted: true, existing: true, intent_id: checkoutIntent(USER_ID, 'op_test_12345'), session_id: SESSION_ID, customer_id: CUSTOMER_ID, idempotency_key: checkoutKey(USER_ID, 'op_test_12345'), status: 'created', reason: 'existing checkout' }]);
        }
        if (parsed.pathname === '/rest/v1/profiles') return response(profile('free', CUSTOMER_ID));
        if (parsed.pathname === '/v1/checkout/sessions') return response(state.stripeSession);
        return null;
      },
      profile: profile('free', CUSTOMER_ID),
    });
    const results = await Promise.all([
      harness.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_12345' })),
      harness.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_12345' })),
    ]);
    assert.deepStrictEqual(results.map((item) => item.status).sort(), [200, 200]);
    assert.strictEqual(harness.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/v1/checkout/sessions')).length, 1);
  });

  await test('namespaces the intent by verified user while retries reuse that user binding', async () => {
    const operationId = 'op_same_for_users';
    const userA = createHarness({ operationId, profile: profile('free', null, null, USER_ID) });
    const firstA = await userA.run(apiRequest('/checkout', 'POST', { operation_id: operationId }));
    const userB = createHarness({
      userId: USER_B,
      operationId,
      profile: profile('free', null, null, USER_B),
    });
    const firstB = await userB.run(apiRequest('/checkout', 'POST', { operation_id: operationId }));
    assert.deepStrictEqual([firstA.status, firstB.status].sort(), [200, 200]);
    const beginCall = (harness) => harness.calls.find((call) => call.url.endsWith('/rpc/begin_stripe_checkout'));
    const bodyA = JSON.parse(beginCall(userA).body);
    const bodyB = JSON.parse(beginCall(userB).body);
    assert.strictEqual(bodyA.p_intent_id, checkoutIntent(USER_ID, operationId));
    assert.strictEqual(bodyB.p_intent_id, checkoutIntent(USER_B, operationId));
    assert.notStrictEqual(bodyA.p_intent_id, bodyB.p_intent_id);
    assert.notStrictEqual(bodyA.p_idempotency_key, bodyB.p_idempotency_key);

    const retry = createHarness({
      operationId,
      profile: profile('free', CUSTOMER_ID, null, USER_ID),
      begin: [{ accepted: true, existing: true, intent_id: checkoutIntent(USER_ID, operationId),
        session_id: SESSION_ID, customer_id: CUSTOMER_ID, idempotency_key: checkoutKey(USER_ID, operationId),
        status: 'created', reason: 'existing checkout' }],
    });
    const retryOut = await retry.run(apiRequest('/checkout', 'POST', { operation_id: operationId }));
    assert.strictEqual(retryOut.status, 200);
    const retryBody = JSON.parse(beginCall(retry).body);
    assert.strictEqual(retryBody.p_intent_id, bodyA.p_intent_id);
    assert.strictEqual(retryBody.p_idempotency_key, bodyA.p_idempotency_key);
  });

  await test('creates the portal only for the exact stored customer', async () => {
    const harness = createHarness({ profile: profile('pro', CUSTOMER_ID) });
    let out = await harness.run(apiRequest('/portal', 'POST', {}));
    assert.strictEqual(out.status, 200);
    assert.strictEqual((await out.json()).portal_url, harness.state.stripePortal.url);
    const injected = await harness.run(apiRequest('/portal', 'POST', { customer: 'cus_attacker', return_url: 'https://evil.synthetic.test' }));
    assert.strictEqual(injected.status, 400);
    const mismatched = createHarness({ profile: profile('pro', CUSTOMER_ID), stripePortal: { ...harness.state.stripePortal, customer: 'cus_other' } });
    out = await mismatched.run(apiRequest('/portal', 'POST', {}));
    assert.strictEqual(out.status, 503);
    const badUrl = createHarness({ profile: profile('pro', CUSTOMER_ID), stripePortal: { ...harness.state.stripePortal, url: 'https://evil.synthetic.test/portal' } });
    out = await badUrl.run(apiRequest('/portal', 'POST', {}));
    assert.strictEqual(out.status, 503);
    const bodyInjection = await harness.run(apiRequest('/portal', 'POST', {
      action: 'cancel', customer: CUSTOMER_ID, subscription: SUBSCRIPTION_ID,
      configuration: PORTAL_CONFIGURATION_ID, return_url: BASE_ENV.STRIPE_PORTAL_RETURN_URL,
    }), PORTAL_ENV);
    assert.strictEqual(bodyInjection.status, 400);
  });

  await test('requires an operator-pinned portal configuration for history and cancellation', async () => {
    const missing = createHarness({ profile: profile('pro', CUSTOMER_ID, SUBSCRIPTION_ID) });
    let out = await missing.run(apiRequest('/portal', 'POST', { action: 'history' }));
    assert.strictEqual(out.status, 503);
    assert.strictEqual((await out.json()).code, 'portal_configuration_required');
    assert.strictEqual(missing.calls.some((call) => call.url.endsWith('/v1/billing_portal/sessions')), false);

    const malformed = createHarness({ profile: profile('pro', CUSTOMER_ID, SUBSCRIPTION_ID) });
    out = await malformed.run(apiRequest('/portal', 'POST', { action: 'history' }), {
      ...PORTAL_ENV, STRIPE_PORTAL_CONFIGURATION_ID: 'portal_attacker_config',
    });
    assert.strictEqual(out.status, 503);
    assert.strictEqual((await out.json()).code, 'portal_configuration_invalid');
    assert.strictEqual(malformed.calls.some((call) => call.url.endsWith('/v1/billing_portal/sessions')), false);

    const disabled = createHarness({
      profile: profile('pro', CUSTOMER_ID, SUBSCRIPTION_ID),
      portalConfig: {
        id: PORTAL_CONFIGURATION_ID, object: 'billing_portal.configuration', active: true, livemode: false,
        features: { invoice_history: { enabled: false }, subscription_cancel: { enabled: false } },
      },
    });
    out = await disabled.run(apiRequest('/portal', 'POST', { action: 'history' }), PORTAL_ENV);
    assert.strictEqual(out.status, 503);
    assert.strictEqual((await out.json()).code, 'billing_history_unavailable');
    out = await disabled.run(apiRequest('/portal', 'POST', { action: 'cancel' }), PORTAL_ENV);
    assert.strictEqual(out.status, 503);
    assert.strictEqual((await out.json()).code, 'subscription_cancel_unavailable');
    assert.strictEqual(disabled.calls.some((call) => call.url.endsWith('/v1/billing_portal/sessions')), false);

    const wrongProviderConfig = createHarness({
      profile: profile('pro', CUSTOMER_ID, SUBSCRIPTION_ID),
      portalConfig: {
        id: 'bpc_other', object: 'billing_portal.configuration', active: true, livemode: false,
        features: { invoice_history: { enabled: true }, subscription_cancel: { enabled: true } },
      },
    });
    out = await wrongProviderConfig.run(apiRequest('/portal', 'POST', { action: 'history' }), PORTAL_ENV);
    assert.strictEqual(out.status, 503);
    assert.strictEqual((await out.json()).code, 'portal_configuration_unavailable');
  });

  await test('creates history through the normal portal with the fixed configuration', async () => {
    const harness = createHarness({ profile: profile('free', CUSTOMER_ID) });
    const out = await harness.run(apiRequest('/portal', 'POST', { action: 'history' }), PORTAL_ENV);
    assert.strictEqual(out.status, 200);
    const portalCall = harness.calls.find((call) => call.url.endsWith('/v1/billing_portal/sessions'));
    assert.ok(portalCall);
    const form = new URLSearchParams(portalCall.body);
    assert.strictEqual(form.get('customer'), CUSTOMER_ID);
    assert.strictEqual(form.get('configuration'), PORTAL_CONFIGURATION_ID);
    assert.strictEqual(form.get('return_url'), PORTAL_ENV.STRIPE_PORTAL_RETURN_URL);
    assert.strictEqual(form.get('flow_data[type]'), null);
    assert.strictEqual(form.get('flow_data[subscription_cancel][subscription]'), null);
  });

  await test('encodes the hosted cancellation flow from the verified subscription only', async () => {
    const harness = createHarness({ profile: profile('free', CUSTOMER_ID, SUBSCRIPTION_ID) });
    const out = await harness.run(apiRequest('/portal', 'POST', { action: 'cancel' }), PORTAL_ENV);
    assert.strictEqual(out.status, 200);
    const portalCall = harness.calls.find((call) => call.url.endsWith('/v1/billing_portal/sessions'));
    assert.ok(portalCall);
    const form = new URLSearchParams(portalCall.body);
    assert.strictEqual(form.get('customer'), CUSTOMER_ID);
    assert.strictEqual(form.get('configuration'), PORTAL_CONFIGURATION_ID);
    assert.strictEqual(form.get('return_url'), PORTAL_ENV.STRIPE_PORTAL_RETURN_URL);
    assert.strictEqual(form.get('flow_data[type]'), 'subscription_cancel');
    assert.strictEqual(form.get('flow_data[subscription_cancel][subscription]'), SUBSCRIPTION_ID);
    assert.strictEqual(form.get('flow_data[after_completion][type]'), 'hosted_confirmation');
    assert.strictEqual(form.get('flow_data[subscription_cancel][subscription]'), harness.state.stripeSubscription.id);
    assert.strictEqual(harness.calls.some((call) => call.url.endsWith('/rpc/apply_stripe_event')), false);
  });

  await test('fails closed for a different customer, stale product or already-cancelled subscription', async () => {
    const differentCustomer = createHarness({
      profile: profile('pro', CUSTOMER_ID, SUBSCRIPTION_ID),
      stripeSubscription: { id: SUBSCRIPTION_ID, customer: 'cus_other', status: 'active', livemode: false, items: { data: [priceItem()] } },
    });
    let out = await differentCustomer.run(apiRequest('/portal', 'POST', { action: 'cancel' }), PORTAL_ENV);
    assert.strictEqual(out.status, 409);
    assert.strictEqual(differentCustomer.calls.some((call) => call.url.endsWith('/v1/billing_portal/sessions')), false);

    const staleProduct = createHarness({
      profile: profile('pro', CUSTOMER_ID, SUBSCRIPTION_ID),
      stripeSubscription: { id: SUBSCRIPTION_ID, customer: CUSTOMER_ID, status: 'active', livemode: false, items: { data: [{ price: { id: 'price_wrong', type: 'recurring', product: PRODUCT_ID } }] } },
    });
    out = await staleProduct.run(apiRequest('/portal', 'POST', { action: 'cancel' }), PORTAL_ENV);
    assert.strictEqual(out.status, 409);
    assert.strictEqual(staleProduct.calls.some((call) => call.url.endsWith('/v1/billing_portal/sessions')), false);

    const alreadyCancelled = createHarness({
      profile: profile('free', CUSTOMER_ID, SUBSCRIPTION_ID),
      stripeSubscription: { id: SUBSCRIPTION_ID, customer: CUSTOMER_ID, status: 'canceled', livemode: false, items: { data: [priceItem()] } },
    });
    out = await alreadyCancelled.run(apiRequest('/portal', 'POST', { action: 'cancel' }), PORTAL_ENV);
    assert.strictEqual(out.status, 409);
    assert.strictEqual((await out.json()).code, 'subscription_cancel_unavailable');
    assert.strictEqual(alreadyCancelled.calls.some((call) => call.url.endsWith('/v1/billing_portal/sessions')), false);

    const scheduled = createHarness({
      profile: profile('pro', CUSTOMER_ID, SUBSCRIPTION_ID),
      stripeSubscription: { id: SUBSCRIPTION_ID, customer: CUSTOMER_ID, status: 'active', cancel_at_period_end: true, livemode: false, items: { data: [priceItem()] } },
    });
    out = await scheduled.run(apiRequest('/portal', 'POST', { action: 'cancel' }), PORTAL_ENV);
    assert.strictEqual(out.status, 409);
    assert.strictEqual(scheduled.calls.some((call) => call.url.endsWith('/v1/billing_portal/sessions')), false);
  });

  await test('exposes account portal capabilities from trusted provider state and keeps plan on pending cancellation', async () => {
    const harness = createHarness({ profile: profile('free', CUSTOMER_ID, SUBSCRIPTION_ID), account: accountRow('free') });
    let out = await harness.run(apiRequest('/account', 'GET'), PORTAL_ENV);
    assert.strictEqual(out.status, 200);
    let account = await out.json();
    assert.strictEqual(account.plan, 'free');
    assert.strictEqual(account.portal_available, true);
    assert.strictEqual(account.history_enabled, true);
    assert.strictEqual(account.cancel_enabled, true);

    harness.state.stripeSubscription = { ...harness.state.stripeSubscription, status: 'canceled' };
    out = await harness.run(apiRequest('/account', 'GET'), PORTAL_ENV);
    assert.strictEqual(out.status, 200);
    account = await out.json();
    assert.strictEqual(account.plan, 'free');
    assert.strictEqual(account.portal_available, true);
    assert.strictEqual(account.history_enabled, true);
    assert.strictEqual(account.cancel_enabled, false);
  });

  await test('returns a safe free account default when the trusted profile RPC is empty', async () => {
    const harness = createHarness({ account: [] });
    const out = await harness.run(apiRequest('/account', 'GET'));
    assert.strictEqual(out.status, 200);
    const payload = await out.json();
    assert.strictEqual(payload.plan, 'free');
    assert.strictEqual(payload.trade_cap, 50);
    assert.strictEqual(payload.allowed_features.simulator, false);
    assert.strictEqual(payload.portal_available, false);
    assert.strictEqual(payload.history_enabled, false);
    assert.strictEqual(payload.cancel_enabled, false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, 'stripe_customer_id'), false);
  });

  await test('keeps account reads on the verified user bearer and never exposes service credentials', async () => {
    const harness = createHarness();
    const out = await harness.run(apiRequest('/account', 'GET'));
    assert.strictEqual(out.status, 200);
    const accountCall = harness.calls.find((call) => call.url.endsWith('/rpc/get_account_state'));
    assert.ok(accountCall);
    assert.strictEqual(accountCall.headers.Authorization, 'Bearer access.synthetic');
    assert.strictEqual(accountCall.headers.apikey, BASE_ENV.SB_PUBLISHABLE_KEY);
    assert.notStrictEqual(accountCall.headers.Authorization, `Bearer ${BASE_ENV.SB_SERVICE_ROLE_KEY}`);
    const body = await out.json();
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, 'stripe_customer_id'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, 'sb_service_role_key'), false);
  });

  await test('sends a new Supabase secret key as apikey only, never as a bearer JWT', async () => {
    const harness = createHarness();
    const out = await harness.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_12345' }), {
      ...BASE_ENV,
      SB_SERVICE_ROLE_KEY: '',
      SB_SECRET_KEY: 'sb_secret_synthetic',
    });
    assert.strictEqual(out.status, 200);
    const rpc = harness.calls.find((call) => call.url.endsWith('/rpc/begin_stripe_checkout'));
    assert.ok(rpc);
    assert.strictEqual(rpc.headers.apikey, 'sb_secret_synthetic');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rpc.headers, 'Authorization'), false);
  });

  await test('rejects unpaid Checkout completion before any entitlement RPC', async () => {
    const harness = createHarness();
    const event = checkoutEvent('evt_unpaid', { payment_status: 'unpaid' });
    const request = await webhookRequest(event);
    const out = await harness.run(request);
    assert.strictEqual(out.status, 400);
    assert.strictEqual(harness.calls.some((call) => call.url.includes('complete_stripe_checkout')), false);
  });

  await test('requires a signed Checkout session ID before any entitlement RPC', async () => {
    const harness = createHarness();
    const event = checkoutEvent('evt_missing_session', { id: undefined });
    const out = await harness.run(await webhookRequest(event));
    assert.strictEqual(out.status, 400);
    assert.strictEqual(harness.calls.some((call) => call.url.includes('complete_stripe_checkout')), false);
  });

  await test('maps a current past-due subscription to free and never grants from an incomplete status', async () => {
    const harness = createHarness({ stripeSubscription: {
      id: SUBSCRIPTION_ID, customer: CUSTOMER_ID, status: 'past_due', livemode: false,
      items: { data: [priceItem()] },
    } });
    const event = subscriptionEvent('evt_past_due', { status: 'past_due' });
    const out = await harness.run(await webhookRequest(event));
    assert.strictEqual(out.status, 200);
    const apply = harness.calls.find((call) => call.url.endsWith('/rpc/apply_stripe_event'));
    assert.strictEqual(JSON.parse(apply.body).p_plan, 'free');
    const incomplete = createHarness({ stripeSubscription: {
      id: SUBSCRIPTION_ID, customer: CUSTOMER_ID, status: 'incomplete', livemode: false,
      items: { data: [priceItem()] },
    } });
    const incompleteOut = await incomplete.run(await webhookRequest(subscriptionEvent('evt_incomplete', { status: 'incomplete' })));
    assert.strictEqual(incompleteOut.status, 200);
    const incompleteApply = incomplete.calls.find((call) => call.url.endsWith('/rpc/apply_stripe_event'));
    assert.strictEqual(JSON.parse(incompleteApply.body).p_plan, 'free');
  });

  await test('handles paused and resumed subscription lifecycle events explicitly', async () => {
    const paused = createHarness({ stripeSubscription: {
      id: SUBSCRIPTION_ID, customer: CUSTOMER_ID, status: 'paused', livemode: false,
      items: { data: [priceItem()] },
    } });
    const pausedOut = await paused.run(await webhookRequest(
      subscriptionEvent('evt_paused', { status: 'paused' }, 'customer.subscription.paused'),
    ));
    assert.strictEqual(pausedOut.status, 200);
    const pausedApply = paused.calls.find((call) => call.url.endsWith('/rpc/apply_stripe_event'));
    assert.strictEqual(JSON.parse(pausedApply.body).p_event_type, 'customer.subscription.paused');
    assert.strictEqual(JSON.parse(pausedApply.body).p_plan, 'free');

    const resumed = createHarness({ stripeSubscription: {
      id: SUBSCRIPTION_ID, customer: CUSTOMER_ID, status: 'active', livemode: false,
      items: { data: [priceItem()] },
    } });
    const resumedOut = await resumed.run(await webhookRequest(
      subscriptionEvent('evt_resumed', { status: 'active' }, 'customer.subscription.resumed'),
    ));
    assert.strictEqual(resumedOut.status, 200);
    const resumedApply = resumed.calls.find((call) => call.url.endsWith('/rpc/apply_stripe_event'));
    assert.strictEqual(JSON.parse(resumedApply.body).p_event_type, 'customer.subscription.resumed');
    assert.strictEqual(JSON.parse(resumedApply.body).p_plan, 'pro');
  });

  await test('does not create a second Checkout for a stored past-due subscription', async () => {
    const harness = createHarness({
      operationId: 'op_recovery_123',
      profile: profile('free', CUSTOMER_ID, SUBSCRIPTION_ID),
      stripeSubscription: {
        id: SUBSCRIPTION_ID, customer: CUSTOMER_ID, status: 'past_due', livemode: false,
        items: { data: [priceItem()] },
      },
    });
    const out = await harness.run(apiRequest('/checkout', 'POST', { operation_id: 'op_recovery_123' }));
    assert.strictEqual(out.status, 409);
    assert.strictEqual((await out.json()).code, 'subscription_recovery_required');
    assert.strictEqual(harness.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/v1/checkout/sessions')).length, 0);
  });

  await test('uses the retrieved current subscription so a stale active event cannot re-grant access', async () => {
    const cancelled = createHarness({ stripeSubscription: {
      id: SUBSCRIPTION_ID, customer: CUSTOMER_ID, status: 'canceled', livemode: false,
      items: { data: [priceItem()] },
    } });
    const updateOut = await cancelled.run(await webhookRequest(subscriptionEvent('evt_stale_active')));
    assert.strictEqual(updateOut.status, 503);
    assert.strictEqual((await updateOut.json()).ignored, 'subscription_changed');
    assert.strictEqual(cancelled.calls.some((call) => call.url.endsWith('/rpc/apply_stripe_event')), false);

    const checkout = createHarness({ stripeSubscription: {
      id: SUBSCRIPTION_ID, customer: CUSTOMER_ID, status: 'canceled', livemode: false,
      items: { data: [priceItem()] },
    } });
    const checkoutOut = await checkout.run(await webhookRequest(checkoutEvent('evt_stale_checkout')));
    assert.strictEqual(checkoutOut.status, 400);
    assert.strictEqual(checkout.calls.some((call) => call.url.endsWith('/rpc/complete_stripe_checkout')), false);

    const replay = createHarness();
    const replayEvent = subscriptionEvent('evt_status_replay');
    let replayOut = await replay.run(await webhookRequest(replayEvent));
    assert.strictEqual(replayOut.status, 200);
    assert.strictEqual(replay.calls.filter((call) => call.url.endsWith('/rpc/apply_stripe_event')).length, 1);
    replay.state.stripeSubscription = { ...replay.state.stripeSubscription, status: 'canceled' };
    replayOut = await replay.run(await webhookRequest(replayEvent));
    assert.strictEqual(replayOut.status, 503);
    assert.strictEqual((await replayOut.json()).ignored, 'subscription_changed');
    assert.strictEqual(replay.calls.filter((call) => call.url.endsWith('/rpc/apply_stripe_event')).length, 1);
  });

  await test('retrieves current paid subscription and binds Checkout completion atomically', async () => {
    const harness = createHarness();
    const event = checkoutEvent();
    const out = await harness.run(await webhookRequest(event));
    assert.strictEqual(out.status, 200);
    const payload = await out.json();
    assert.strictEqual(payload.synced, true);
    const complete = harness.calls.find((call) => call.url.endsWith('/rpc/complete_stripe_checkout'));
    assert.ok(complete);
    assert.strictEqual(JSON.parse(complete.body).p_session_id, SESSION_ID);
  });

  await test('acknowledges a stale or duplicate subscription event only after the fence proves it', async () => {
    const stale = createHarness({ apply: [{ applied: false, duplicate: false, matched: 1, reason: 'stale event' }] });
    let out = await stale.run(await webhookRequest(subscriptionEvent('evt_stale')));
    assert.strictEqual(out.status, 200);
    assert.strictEqual((await out.json()).ignored, 'stale');
    const duplicate = createHarness({ apply: [{ applied: false, duplicate: true, matched: 1, reason: 'duplicate' }] });
    out = await duplicate.run(await webhookRequest(subscriptionEvent('evt_duplicate')));
    assert.strictEqual(out.status, 200);
    assert.strictEqual((await out.json()).duplicate, true);
    const reused = createHarness({ apply: [{ applied: false, duplicate: false, matched: 1, reason: 'Stripe event ID was reused with different data' }] });
    out = await reused.run(await webhookRequest(subscriptionEvent('evt_reused')));
    assert.strictEqual(out.status, 503);
  });

  await test('enforces the API body-size limit and preflight origin contract', async () => {
    const harness = createHarness();
    const huge = 'x'.repeat(17 * 1024);
    const oversized = new Request('https://billing.synthetic.test/checkout', {
      method: 'POST',
      headers: { Origin: ORIGIN, Authorization: 'Bearer access.synthetic', 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation_id: huge }),
    });
    let out = await harness.run(oversized);
    assert.strictEqual(out.status, 413);
    const preflight = new Request('https://billing.synthetic.test/checkout', {
      method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    out = await harness.run(preflight);
    assert.strictEqual(out.status, 204);
    assert.strictEqual(out.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  });

  await test('rejects replayed, changed-raw-body and malformed signatures', async () => {
    const harness = createHarness();
    const event = subscriptionEvent('evt_signature');
    const raw = JSON.stringify(event);
    let out = await harness.run(new Request('https://billing.synthetic.test/webhook', { method: 'POST', body: raw }));
    assert.strictEqual(out.status, 400);
    const valid = await signature(raw);
    const changed = new Request('https://billing.synthetic.test/webhook', {
      method: 'POST', headers: { 'Stripe-Signature': valid }, body: raw.replace('active', 'trialing'),
    });
    out = await harness.run(changed);
    assert.strictEqual(out.status, 400);
    const stale = await webhookRequest(event, raw, String(NOW - 301));
    out = await harness.run(stale);
    assert.strictEqual(out.status, 400);
  });

  await test('returns 503 on provider or database failure, never false-success 2xx', async () => {
    const providerFailure = createHarness();
    providerFailure.failWith(new Error('synthetic provider failure'));
    let out = await providerFailure.run(apiRequest('/checkout', 'POST', { operation_id: 'op_test_12345' }));
    assert.strictEqual(out.status, 503);
    const rpcFailure = createHarness({ fetchOverride: async (url, options, state) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/rpc/apply_stripe_event')) return response({ error: 'synthetic database failure' }, 500);
      if (parsed.pathname === `/v1/subscriptions/${SUBSCRIPTION_ID}`) return response(state.stripeSubscription);
      return null;
    } });
    out = await rpcFailure.run(await webhookRequest(subscriptionEvent('evt_rpc_failure')));
    assert.strictEqual(out.status, 503);
  });

  assert.strictEqual(logLeak, false, 'no token or secret was logged');
  console.log = originalLog;
  console.error = originalError;
  console.log(`Tests completed: ${passed} passed, ${failed} failed.`);
  if (failed) process.exitCode = 1;
})();
