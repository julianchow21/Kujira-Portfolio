// Executable M9 billing control tests against the real extracted UI functions.
// These tests use synthetic state and deferred promises only. They never open a
// browser, read user storage, or call a network service.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const indexPath = path.join(__dirname, '..', 'index.html');
const indexSource = fs.readFileSync(indexPath, 'utf8');

function extractFunction(source, name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  if (!match) throw new Error(`function ${name} was not found`);
  let i = source.indexOf('(', match.index);
  let depth = 1;
  for (i += 1; depth && i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') depth -= 1;
  }
  while (source[i] !== '{') i += 1;
  let braces = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') braces += 1;
    else if (source[i] === '}') {
      braces -= 1;
      if (!braces) {
        i += 1;
        break;
      }
    }
  }
  if (source[i] === ';') i += 1;
  return source.slice(match.index, i);
}

const extracted = [
  'currentUser',
  'scopeSnapshot',
  'scopeIsCurrent',
  'isHostedAuthenticated',
  'normaliseBillingState',
  'safeBillingUrl',
  'setBillingError',
  'billingAction',
].map((name) => extractFunction(indexSource, name)).join('\n');

function user(id) {
  return {
    id,
    email: `${id}@synthetic.invalid`,
    local: false,
    hosted: true,
    authenticated: true,
    scope: `user-${id}`,
  };
}

function makeHarness() {
  const calls = [];
  const assigned = [];
  const toasts = [];
  const context = vm.createContext({
    console,
    Promise,
    Error,
    Number,
    String,
    Object,
    Array,
    RegExp,
    Math,
    URL,
    Set,
    Map,
    JSON,
    crypto: { randomUUID: () => 'operation-synthetic-1' },
    window: { location: { assign: (url) => assigned.push(url) } },
    globalThis: null,
  });
  context.globalThis = context;
  vm.runInContext(`
    var FREE_TRADE_CAP = 50;
    var BILLING_FEATURE_KEYS = ['unlimited_trades','simulator','advanced_analytics','ai_coach','chart_markers','csv_import'];
    var FOREX_CONFIG = { mode: 'hosted', workerUrl: 'https://billing.synthetic.invalid' };
    var STORAGE_KEY = 'test_forex';
    var _authUser = ${JSON.stringify(user('A'))};
    var _authEpoch = 1, _scopeEpoch = 1, _activeScope = 'user-A';
    var _billingState = {
      configured: true, available: true, plan: 'pro', trade_count: 7,
      trade_cap: null,
      allowed_features: { unlimited_trades: true, simulator: true, advanced_analytics: true, ai_coach: true, chart_markers: true, csv_import: true },
      billing_status: 'active', billing_enabled: true, checkout_available: false,
      portal_enabled: true, portal_available: true, history_enabled: true, cancel_enabled: true, reason: ''
    };
    var _accountState = { plan: 'pro', trade_count: 7, trade_cap: null, entitlements: { unlimited_trades: true, simulator: true } };
    var _checkoutOperation = null;
    var _billingError = '';
    var __billingNode = { textContent: '' };
    var document = { getElementById: function(id) { return id === 'billing-error' ? __billingNode : null; } };
    function scopeForUser(value) { return value && value.id ? 'user-' + value.id : 'hosted-anonymous'; }
    function toast(message, error) { __toasts.push({ message, error: !!error }); }
    function billingFailure(result, fallback) { var e = new Error(fallback || 'Billing request failed'); e.code = 'billing_failed'; return e; }
    var billingRequest = async function(path, method, body, scope) {
      __calls.push({ path, method, body, scope });
      return { response: { ok: true, status: 200 }, payload: { portal_url: 'https://billing.stripe.com/p/session-synthetic' }, snapshot: scope };
    };
  `, context, { filename: 'settings-harness-prefix.js' });
  context.__calls = calls;
  context.__assigned = assigned;
  context.__toasts = toasts;
  vm.runInContext(extracted, context, { filename: 'extracted-settings.js' });
  return { context, calls, assigned, toasts };
}

function switchAccount(harness, id) {
  const { context } = harness;
  context._authUser = user(id);
  context._authEpoch += 1;
  context._scopeEpoch += 1;
  context._activeScope = `user-${id}`;
}

function setPortalState(harness, overrides = {}) {
  Object.assign(harness.context._billingState, {
    available: true,
    billing_enabled: true,
    portal_enabled: true,
    portal_available: true,
    history_enabled: true,
    cancel_enabled: true,
    ...overrides,
  });
}

async function settled(action) {
  await action;
  await new Promise((resolve) => setImmediate(resolve));
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error.stack || error);
    failed += 1;
  }
}

(async () => {
  await test('normalises the server capability and entitlement contract', async () => {
    const harness = makeHarness();
    const state = harness.context.normaliseBillingState({
      plan: 'pro',
      trade_count: 12,
      trade_cap: 50,
      billing_status: 'active',
      billing_enabled: true,
      checkout_available: false,
      portal_available: true,
      history_enabled: true,
      cancel_enabled: true,
      allowed_features: { unlimited_trades: true, simulator: true, ai_coach: 'yes' },
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(state)), {
      configured: true,
      available: true,
      plan: 'pro',
      trade_count: 12,
      trade_cap: null,
      allowed_features: {
        unlimited_trades: true,
        simulator: true,
        advanced_analytics: false,
        ai_coach: false,
        chart_markers: false,
        csv_import: false,
      },
      billing_status: 'active',
      billing_enabled: true,
      checkout_available: false,
      portal_enabled: true,
      portal_available: true,
      history_enabled: true,
      cancel_enabled: true,
      reason: '',
    });
  });

  for (const [action, expectedBody] of [
    ['manage', {}],
    ['history', { action: 'history' }],
    ['cancel', { action: 'cancel' }],
  ]) {
    await test(`${action} sends the exact server-owned portal payload`, async () => {
      const harness = makeHarness();
      await settled(harness.context.billingAction(action));
      assert.strictEqual(harness.calls.length, 1);
      assert.deepStrictEqual({
        path: harness.calls[0].path,
        method: harness.calls[0].method,
        body: JSON.parse(JSON.stringify(harness.calls[0].body)),
      }, {
        path: '/portal',
        method: 'POST',
        body: expectedBody,
      });
      assert.strictEqual(harness.calls[0].scope.userId, 'A');
      assert.strictEqual(harness.assigned[0], 'https://billing.stripe.com/p/session-synthetic');
    });
  }

  await test('capability-denied actions fail closed without a request or redirect', async () => {
    for (const [action, key] of [['manage', 'portal_enabled'], ['history', 'history_enabled'], ['cancel', 'cancel_enabled']]) {
      const harness = makeHarness();
      setPortalState(harness, { [key]: false });
      await settled(harness.context.billingAction(action));
      assert.strictEqual(harness.calls.length, 0, action);
      assert.strictEqual(harness.assigned.length, 0, action);
    }
  });

  await test('unsafe Stripe URLs cannot redirect', async () => {
    for (const [action, payload] of [
      ['manage', { portal_url: 'https://evil.synthetic.invalid/p' }],
      ['history', { portal_url: 'http://billing.stripe.com/p' }],
      ['cancel', { portal_url: 'https://billing.stripe.com.evil.invalid/p' }],
    ]) {
      const harness = makeHarness();
      harness.context.billingRequest = async (path, method, body, scope) => {
        harness.calls.push({ path, method, body, scope });
        return { response: { ok: true, status: 200 }, payload, snapshot: scope };
      };
      await settled(harness.context.billingAction(action));
      assert.strictEqual(harness.assigned.length, 0, action);
    }
  });

  await test('an account switch during the request cannot redirect', async () => {
    const harness = makeHarness();
    let resolveRequest;
    harness.context.billingRequest = async (path, method, body, scope) => {
      harness.calls.push({ path, method, body, scope });
      return new Promise((resolve) => { resolveRequest = () => resolve({
        response: { ok: true, status: 200 },
        payload: { portal_url: 'https://billing.stripe.com/p/session-stale' },
        snapshot: scope,
      }); });
    };
    const pending = harness.context.billingAction('cancel');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(harness.calls.length, 1);
    switchAccount(harness, 'B');
    resolveRequest();
    await pending;
    assert.strictEqual(harness.assigned.length, 0);
  });

  await test('cancellation does not locally change plan or entitlements', async () => {
    const harness = makeHarness();
    const beforeBilling = JSON.parse(JSON.stringify(harness.context._billingState));
    const beforeAccount = JSON.parse(JSON.stringify(harness.context._accountState));
    await settled(harness.context.billingAction('cancel'));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.context._billingState)), beforeBilling);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.context._accountState)), beforeAccount);
  });

  await test('provider failure sets accessible inline billing feedback without changing the plan', async () => {
    const harness = makeHarness();
    const beforeBilling = JSON.parse(JSON.stringify(harness.context._billingState));
    const beforeAccount = JSON.parse(JSON.stringify(harness.context._accountState));
    harness.context.billingRequest = async (path, method, body, scope) => ({
      response: { ok: false, status: 503 },
      payload: { code: 'portal_create_failed', reason: 'synthetic provider failure' },
      snapshot: scope,
    });
    await settled(harness.context.billingAction('manage'));
    assert.strictEqual(harness.context._billingError, 'Billing is temporarily unavailable. Try again.');
    assert.strictEqual(harness.context.__billingNode.textContent, 'Billing is temporarily unavailable. Try again.');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.context._billingState)), beforeBilling);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.context._accountState)), beforeAccount);
    assert.strictEqual(harness.assigned.length, 0);
  });

  console.log(`Tests completed: ${passed} passed, ${failed} failed.`);
  if (failed) process.exitCode = 1;
})();
