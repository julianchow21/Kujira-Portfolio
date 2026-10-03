#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normaliseOrigin } = require('./check-launch.js');

const repoRoot = path.resolve(__dirname, '..', '..');
const forexRoot = path.join(repoRoot, 'Forex');
const checker = path.join(forexRoot, 'tests', 'check-launch.js');
const fixtureOrigin = 'https://forex.synthetic.test';
const workerOrigin = 'https://billing.synthetic.test';

assert.equal(normaliseOrigin(fixtureOrigin + '/'), fixtureOrigin);
assert.throws(() => normaliseOrigin('https://user:pass@forex.synthetic.test'), /without credentials/);

function run(args) {
  const result = spawnSync(process.execPath, [checker, ...args], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  if (result.error) throw result.error;
  return result;
}

function writeReadyFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'forex-launch-'));
  const pages = ['index.html', 'welcome.html', 'pricing.html', 'terms.html', 'privacy.html', 'refunds.html'];
  for (const page of pages) fs.copyFileSync(path.join(forexRoot, page), path.join(fixture, page));

  const workerCsp = (source) => source.replace(/(connect-src\s+[^;]+)/i, '$1 ' + workerOrigin);
  fs.writeFileSync(path.join(fixture, 'index.html'), workerCsp(fs.readFileSync(path.join(fixture, 'index.html'), 'utf8')));
  fs.writeFileSync(path.join(fixture, 'pricing.html'), workerCsp(fs.readFileSync(path.join(fixture, 'pricing.html'), 'utf8')));

  const runtime = {
    authEnabled: true,
    supabaseUrl: 'https://project.synthetic.supabase.co',
    supabaseAnonKey: 'sb_publishable_fixture',
    workerUrl: workerOrigin,
    workerConnectOrigin: workerOrigin,
    authRedirectOrigin: fixtureOrigin
  };
  const configSource = fs.readFileSync(path.join(forexRoot, 'config.js'), 'utf8');
  fs.writeFileSync(path.join(fixture, 'config.js'), `globalThis.__KJR_FOREX_CONFIG__ = ${JSON.stringify(runtime)};\n${configSource}`);

  const publicConfig = {
    schemaVersion: 1,
    mode: 'READY',
    reviewFlags: { pricing: true, operator: true, legal: true },
    currency: 'USD',
    proPriceMonthly: 12.34,
    proPriceAnnual: 123.45,
    proFeatures: ['Unlimited trades', 'Simulator'],
    signUpHref: './index.html?v=0.14#signup',
    signInHref: './index.html?v=0.14#account',
    checkoutEnabled: true
  };
  fs.writeFileSync(path.join(fixture, 'public-config.js'), `globalThis.KJR_PUBLIC_CONFIG = Object.freeze(${JSON.stringify(publicConfig)});\n`);
  for (const page of ['terms.html', 'privacy.html', 'refunds.html']) {
    const file = path.join(fixture, page);
    const source = fs.readFileSync(file, 'utf8')
      .replaceAll('DRAFT PREVIEW', 'Published source fixture')
      .replaceAll('Launch not approved', 'Launch approved in synthetic fixture');
    fs.writeFileSync(file, source);
  }
  return fixture;
}

const defaultRun = run([]);
assert.equal(defaultRun.status, 2);
assert.match(defaultRun.stdout, /ORIGIN=synthetic local check only/);
assert.match(defaultRun.stdout, /BLOCKER=legal pages remain draft or launch approval is missing/);

const fixture = writeReadyFixture();
try {
  const missingOrigin = run(['--root', fixture]);
  assert.equal(missingOrigin.status, 2);
  assert.match(missingOrigin.stdout, /BLOCKER=--origin is required when hosted settings are configured/);

  const invalidOrigin = run(['--root', fixture, '--origin', 'javascript:bad']);
  assert.equal(invalidOrigin.status, 2);
  assert.match(invalidOrigin.stdout, /BLOCKER=--origin must be an HTTPS origin/);

  const legalPath = path.join(fixture, 'privacy.html');
  const legalSource = fs.readFileSync(legalPath, 'utf8');
  fs.writeFileSync(legalPath, '');
  const emptyLegal = run(['--root', fixture, '--origin', fixtureOrigin]);
  assert.equal(emptyLegal.status, 2);
  assert.match(emptyLegal.stdout, /BLOCKER=all three legal documents must be present and non-empty/);
  fs.writeFileSync(legalPath, legalSource);

  const ready = run(['--root', fixture, '--origin', fixtureOrigin]);
  assert.equal(ready.status, 0);
  assert.match(ready.stdout, /ORIGIN=https:\/\/forex\.synthetic\.test/);
  assert.match(ready.stdout, /HOSTED_LAUNCH=SOURCE_READY/);
  assert.doesNotMatch(ready.stdout, /BLOCKER=/);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log('Launch CLI tests: 4 passed, 0 failed.');
