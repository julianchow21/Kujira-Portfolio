#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const publicApi = require('../lib/public.js');
const { evaluateLaunch, resolveRuntime } = require('./check-launch.js');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const indexCsp = (/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(indexSource) || [])[1] || '';
const addConnectSource = (policy, origin) => policy.replace(/(connect-src\s+[^;]+)/i, '$1 ' + origin);
const syntheticRuntime = (overrides = {}, csp = addConnectSource(indexCsp, 'https://billing.synthetic.test')) => resolveRuntime({
  configInput: {},
  input: {
    authEnabled: true,
    supabaseUrl: 'https://project.synthetic.supabase.co',
    supabaseAnonKey: 'sb_publishable_fixture',
    workerUrl: 'https://billing.synthetic.test',
    workerConnectOrigin: 'https://billing.synthetic.test',
    authRedirectOrigin: 'https://forex.synthetic.test',
    ...overrides
  },
  csp,
  origin: 'https://forex.synthetic.test'
});

function test(name, fn) {
  try {
    fn();
    console.log('PASS', name);
  } catch (error) {
    console.error('FAIL', name, error.message);
    process.exitCode = 1;
  }
}

test('missing public config stays in the preview state', () => {
  const config = publicApi.normaliseConfig(null);
  assert.equal(config.mode, 'PREVIEW');
  assert.equal(config.pricingApproved, false);
  assert.equal(config.proPriceMonthly, null);
  assert.equal(config.checkoutEnabled, false);
});

test('malformed commercial values fail closed', () => {
  const config = publicApi.normaliseConfig({
    mode: 'READY',
    reviewFlags: { pricing: true, operator: true, legal: true },
    currency: 'US<script>',
    proPriceMonthly: 'not-a-price',
    checkoutEnabled: true
  });
  assert.equal(config.mode, 'PREVIEW');
  assert.equal(config.pricingApproved, false);
  assert.equal(config.currency, null);
});

test('unsupported, boolean and sub-cent commercial values stay unset', () => {
  const base = { mode: 'READY', reviewFlags: { pricing: true, operator: true, legal: true }, checkoutEnabled: true };
  assert.equal(publicApi.normaliseConfig({ ...base, currency: 'ZZZ', proPriceMonthly: 12.34 }).pricingApproved, false);
  assert.equal(publicApi.normaliseConfig({ ...base, currency: ' USD ', proPriceMonthly: true }).pricingApproved, false);
  assert.equal(publicApi.normaliseConfig({ ...base, currency: ' USD ', proPriceMonthly: 0.001 }).pricingApproved, false);
  const trimmed = publicApi.normaliseConfig({ ...base, currency: ' USD ', proPriceMonthly: 12.34 }, syntheticRuntime());
  assert.equal(trimmed.currency, 'USD');
  assert.equal(trimmed.pricingApproved, true);
});

test('approved fixture values render only when every review flag is true', () => {
  // TEST FIXTURE ONLY, these values are not product pricing and are not shipped
  const runtime = syntheticRuntime();
  assert.equal(runtime.mode, 'hosted');
  assert.equal(runtime.errors.length, 0);
  const approved = publicApi.normaliseConfig({
    mode: 'READY',
    reviewFlags: { pricing: true, operator: true, legal: true },
    currency: 'USD',
    proPriceMonthly: 12.34,
    proPriceAnnual: 123.45,
    checkoutEnabled: true
  }, runtime);
  assert.equal(approved.mode, 'READY');
  assert.equal(approved.pricingApproved, true);
  assert.equal(publicApi.formatPrice(approved, approved.proPriceMonthly, 'month'), 'USD 12.34 / month');
});

test('unsafe links fall back to fixed local account entries', () => {
  const config = publicApi.normaliseConfig({
    signUpHref: 'javascript:alert(1)',
    signInHref: 'https://evil.example/account'
  });
  assert.equal(config.signUpHref, publicApi.DEFAULT_SIGNUP);
  assert.equal(config.signInHref, publicApi.DEFAULT_SIGNIN);
  assert.equal(publicApi.safeRelativeHref('./index.html?v=0.14#signup', ''), './index.html?v=0.14#signup');
  assert.equal(publicApi.safeRelativeHref('./<img>.html', ''), '');
});

test('welcome keeps a visible pricing route in page content', () => {
  const welcome = fs.readFileSync(path.join(__dirname, '..', 'welcome.html'), 'utf8');
  assert.match(welcome, /<a class="button" href="\.\/pricing\.html">View pricing<\/a>/);
});

test('public pages use the versioned stylesheet asset', () => {
  for (const file of ['welcome.html', 'pricing.html', 'terms.html', 'privacy.html', 'refunds.html']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(source, /href="lib\/public\.css\?v=0\.14"/);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'public.css'), 'utf8'), /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});

function fakeNode() {
  const node = {
    textContent: '',
    dataset: {},
    attributes: {},
    children: [],
    classList: {
      values: new Set(),
      toggle(name, enabled) { if (enabled) this.values.add(name); else this.values.delete(name); }
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); }
  };
  return node;
}

function fakePricingDocument() {
  const selectors = [
    '[data-public-status]', '[data-pricing-state]', '[data-pricing-copy]', '[data-preview-copy]',
    '[data-plan-list-copy]', '[data-local-copy]', '[data-local-access]', '[data-local-kicker]', '[data-local-cta]', '[data-free-availability]',
    '[data-local-plan]',
    '[data-free-kicker]', '[data-free-price]', '[data-free-copy]', '[data-pro-kicker]',
    '[data-pro-price-monthly]', '[data-pro-price-annual]', '[data-pro-copy]', '[data-checkout-state]',
    '[data-free-cta]', '[data-entry-title]', '[data-entry-copy]', '[data-signup-link]',
    '[data-signin-link]', '[data-checkout-link]', '[data-pro-features]'
  ];
  const nodes = Object.fromEntries(selectors.map((selector) => [selector, fakeNode()]));
  nodes['[data-public-footer]'] = fakeNode();
  const page = fakeNode();
  page.querySelector = (selector) => selector === '[data-public-footer]' ? null : nodes[selector] || null;
  const documentLike = {
    querySelector: (selector) => selector === '[data-public-pricing]' ? page : selector === '[data-public-footer]' ? nodes['[data-public-footer]'] : null,
    createElement: () => fakeNode()
  };
  return { documentLike, page, nodes };
}

test('render updates every pricing state for a ready synthetic fixture', () => {
  const fixture = {
    mode: 'READY',
    reviewFlags: { pricing: true, operator: true, legal: true },
    currency: 'USD',
    proPriceMonthly: 12.34,
    proPriceAnnual: 123.45,
    checkoutEnabled: true,
    proFeatures: ['Unlimited trades', 'Simulator']
  };
  const fake = fakePricingDocument();
  const config = publicApi.render(fake.documentLike, fixture, syntheticRuntime());
  assert.equal(config.mode, 'READY');
  assert.equal(fake.nodes['[data-public-status]'].textContent, 'Pricing available');
  assert.match(fake.nodes['[data-pricing-copy]'].textContent, /available/);
  assert.equal(fake.nodes['[data-free-kicker]'].textContent, 'Available');
  assert.equal(fake.nodes['[data-pro-kicker]'].textContent, 'Available');
  assert.equal(fake.nodes['[data-pro-price-monthly]'].textContent, 'USD 12.34 / month');
  assert.equal(fake.nodes['[data-pro-price-annual]'].textContent, 'USD 123.45 / year');
  assert.equal(fake.nodes['[data-checkout-state]'].textContent, 'View account options');
  assert.equal(fake.nodes['[data-checkout-link]'].attributes['aria-disabled'], 'false');
  assert.equal(fake.nodes['[data-pro-features]'].children.length, 2);
  const renderedText = Object.values(fake.nodes).map((node) => node.textContent).join(' ');
  assert.doesNotMatch(renderedText, /planned|unavailable|preview|to be announced/i);
  assert.equal(fake.nodes['[data-local-plan]'].hidden, true);
  assert.equal(fake.nodes['[data-local-plan]'].attributes.hidden, '');
  assert.match(fake.nodes['[data-plan-list-copy]'].textContent, /Free and Pro account/);
  assert.equal(fake.nodes['[data-local-access]'].textContent, 'Account required');
  assert.equal(fake.nodes['[data-local-kicker]'].textContent, 'Account required');
  assert.equal(fake.nodes['[data-local-cta]'].textContent, 'Sign in');
  assert.equal(fake.nodes['[data-local-cta]'].attributes.href, './index.html?v=0.14#account');
  assert.match(fake.nodes['[data-public-footer]'].textContent, /Published plan/);
});

test('commercial values cannot advertise readiness when Auth is disabled', () => {
  const fixture = {
    mode: 'READY',
    reviewFlags: { pricing: true, operator: true, legal: true },
    currency: 'USD',
    proPriceMonthly: 12.34,
    checkoutEnabled: true
  };
  const fake = fakePricingDocument();
  const config = publicApi.render(fake.documentLike, fixture, syntheticRuntime({ authEnabled: false }));
  assert.equal(config.mode, 'PREVIEW');
  assert.equal(fake.nodes['[data-local-plan]'].hidden, false);
  assert.equal(fake.nodes['[data-local-plan]'].attributes.hidden, undefined);
  assert.equal(fake.nodes['[data-public-status]'].textContent, 'Private preview');
  assert.match(fake.nodes['[data-pricing-copy]'].textContent, /remain unavailable/);
  assert.match(fake.nodes['[data-public-footer]'].textContent, /Private preview/);
});

test('launch check separates local pass from runtime and legal blockers', () => {
  const fixture = {
    mode: 'READY',
    reviewFlags: { pricing: true, operator: true, legal: true },
    currency: 'USD',
    proPriceMonthly: 12.34,
    checkoutEnabled: true
  };
  const defaultResult = evaluateLaunch({
    publicConfig: {},
    runtime: syntheticRuntime({ authEnabled: false }),
    legalSources: ['DRAFT PREVIEW', 'DRAFT PREVIEW', 'DRAFT PREVIEW']
  });
  assert.equal(defaultResult.ready, false);
  assert.equal(defaultResult.blockers.length, 3);

  const malformedRuntime = syntheticRuntime({
    workerUrl: 'javascript:bad',
    workerConnectOrigin: 'javascript:bad'
  });
  assert.ok(malformedRuntime.errors.length > 0);
  const malformedResult = evaluateLaunch({
    publicConfig: fixture,
    runtime: malformedRuntime,
    legalSources: ['approved', 'approved', 'approved']
  });
  assert.equal(malformedResult.ready, false);
  assert.match(malformedResult.blockers.join('|'), /runtime/);

  const missingWorkerRuntime = syntheticRuntime({ workerUrl: '', workerConnectOrigin: '' });
  const missingWorkerResult = evaluateLaunch({
    publicConfig: fixture,
    runtime: missingWorkerRuntime,
    legalSources: ['approved', 'approved', 'approved']
  });
  assert.equal(missingWorkerResult.ready, false);
  assert.match(missingWorkerResult.blockers.join('|'), /runtime/);

  const missingCspRuntime = syntheticRuntime({}, indexCsp);
  assert.ok(missingCspRuntime.errors.length > 0);
  const missingCspResult = evaluateLaunch({
    publicConfig: fixture,
    runtime: missingCspRuntime,
    legalSources: ['approved', 'approved', 'approved']
  });
  assert.equal(missingCspResult.ready, false);

  const partialResult = evaluateLaunch({
    publicConfig: { ...fixture, reviewFlags: { pricing: true, operator: false, legal: false } },
    runtime: syntheticRuntime(),
    legalSources: ['approved', 'approved', 'approved']
  });
  assert.equal(partialResult.ready, false);
  const readyResult = evaluateLaunch({
    publicConfig: fixture,
    runtime: syntheticRuntime(),
    legalSources: ['approved', 'approved', 'approved']
  });
  assert.equal(readyResult.ready, true);
  const draftResult = evaluateLaunch({
    publicConfig: fixture,
    runtime: syntheticRuntime(),
    legalSources: ['DRAFT PREVIEW', 'DRAFT PREVIEW', 'DRAFT PREVIEW']
  });
  assert.equal(draftResult.ready, false);
  assert.match(draftResult.blockers.join('|'), /legal/);
  const missingLegalResult = evaluateLaunch({
    publicConfig: fixture,
    runtime: syntheticRuntime(),
    legalSources: ['approved', '', 'approved']
  });
  assert.equal(missingLegalResult.ready, false);
  assert.match(missingLegalResult.blockers.join('|'), /all three legal documents/);
});

console.log(process.exitCode ? 'PUBLIC TESTS FAILED' : 'PUBLIC TESTS COMPLETE');
