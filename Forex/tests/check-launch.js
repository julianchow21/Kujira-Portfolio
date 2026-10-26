#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publicApi = require('../lib/public.js');

const DEFAULT_SOURCE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ORIGIN = 'https://forex.synthetic.test';
const VM_TIMEOUT_MS = 250;
const LEGAL_PAGES = ['terms.html', 'privacy.html', 'refunds.html'];

function read(file, sourceRoot = DEFAULT_SOURCE_ROOT) {
  return fs.readFileSync(path.join(sourceRoot, file), 'utf8');
}

function cspFrom(source) {
  return (/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(source) || [])[1] || '';
}

function connectDirective(policy) {
  return (/(?:^|;)\s*connect-src\s+([^;]+)/i.exec(policy) || [])[1] || '';
}

// Sources only the app page carries, for chart data (the Trading Worker on workers.dev). The public pages never
// fetch charts, so pricing.html deliberately leaves them out and the pricing-versus-index contract ignores them.
const APP_ONLY_CONNECT_SOURCES = Object.freeze(['https://*.workers.dev']);

function connectSources(policy, ignore = []) {
  return connectDirective(policy).split(/\s+/).filter((source) => source && !ignore.includes(source));
}

function normaliseOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('--origin requires an application origin URL');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch (_) {
    throw new Error('--origin must be a valid URL');
  }
  const host = url.hostname.toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]' || host === '::1';
  const protocolOkay = url.protocol === 'https:' || (url.protocol === 'http:' && local);
  if (!protocolOkay || url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('--origin must be an HTTPS origin without credentials, path, query or fragment');
  }
  return url.origin.replace(/\/$/, '');
}

function loadConfigContext(csp, origin, sourceRoot = DEFAULT_SOURCE_ROOT) {
  const context = {
    URL,
    Intl,
    Set,
    location: { origin },
    document: {
      querySelector(selector) {
        if (selector !== 'meta[http-equiv="Content-Security-Policy"]') return null;
        return { getAttribute: (name) => name === 'content' ? csp : '' };
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(read('config.js', sourceRoot), context, {
    filename: 'config.js',
    timeout: VM_TIMEOUT_MS
  });
  return context;
}

function loadConfigApi(csp, origin, sourceRoot = DEFAULT_SOURCE_ROOT) {
  return loadConfigContext(csp, origin, sourceRoot).KjrForexConfig;
}

function resolveRuntime({ input, csp, origin, sourceRoot = DEFAULT_SOURCE_ROOT }) {
  const api = loadConfigApi(csp, origin, sourceRoot);
  return api.resolve(input || {}, { origin });
}

function runtimeNeedsExplicitOrigin(runtime) {
  if (!runtime || runtime.mode !== 'offline') return true;
  return Boolean(
    runtime.supabaseUrl
    || runtime.supabaseAnonKey
    || runtime.workerUrl
    || runtime.workerConnectOrigin
    || runtime.authRedirectOrigin
  );
}

function evaluateLaunch({ publicConfig, runtime, legalSources, originRequired = false }) {
  const config = publicApi.normaliseConfig(publicConfig, runtime);
  const blockers = [];
  if (config.mode !== 'READY' || !config.pricingApproved) {
    blockers.push('public commercial configuration is not ready');
  }
  if (!publicApi.runtimeReady(runtime)) {
    const errors = runtime && Array.isArray(runtime.errors) && runtime.errors.length
      ? ': ' + runtime.errors.join(', ')
      : '';
    blockers.push('resolved Auth and Worker runtime is not hosted-ready' + errors);
  }
  const legal = Array.isArray(legalSources) ? legalSources : [];
  if (legal.length !== LEGAL_PAGES.length || legal.some((source) => typeof source !== 'string' || !source.trim())) {
    blockers.push('all three legal documents must be present and non-empty');
  }
  if (legal.some((source) => /DRAFT PREVIEW|Launch not approved/.test(String(source)))) {
    blockers.push('legal pages remain draft or launch approval is missing');
  }
  if (originRequired) {
    blockers.push('--origin is required when hosted settings are configured');
  }
  return Object.freeze({ config, blockers: Object.freeze(blockers), ready: blockers.length === 0 });
}

function loadPublicConfig(sourceRoot = DEFAULT_SOURCE_ROOT) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(read('public-config.js', sourceRoot), context, {
    filename: 'public-config.js',
    timeout: VM_TIMEOUT_MS
  });
  return context.KJR_PUBLIC_CONFIG;
}

function checkSourceShape(publicConfig, sourceRoot = DEFAULT_SOURCE_ROOT) {
  assert.deepEqual(Object.keys(publicConfig).sort(), [
    'checkoutEnabled', 'currency', 'mode', 'proFeatures', 'proPriceAnnual',
    'proPriceMonthly', 'reviewFlags', 'schemaVersion', 'signInHref', 'signUpHref'
  ].sort());
  assert.equal(typeof publicConfig.schemaVersion, 'number');
  assert.deepEqual(Object.keys(publicConfig.reviewFlags).sort(), ['legal', 'operator', 'pricing']);

  const pricing = read('pricing.html', sourceRoot);
  assert.match(pricing, /data-public-pricing/);
  assert.match(pricing, /config\.js\?v=1\.0/);
  assert.match(pricing, /public-config\.js\?v=0\.16/);
  assert.match(pricing, /lib\/public\.js\?v=0\.16/);
  assert.ok(pricing.indexOf('config.js?v=1.0') < pricing.indexOf('lib/public.js?v=0.16'), 'runtime config must load before public renderer');
  const indexCsp = cspFrom(read('index.html', sourceRoot));
  const pricingCsp = cspFrom(pricing);
  assert.ok(connectDirective(indexCsp), 'index CSP must declare connect-src');
  assert.ok(connectDirective(pricingCsp), 'pricing CSP must declare connect-src');
  assert.equal(
    connectSources(pricingCsp).join(' '),
    connectSources(indexCsp, APP_ONLY_CONNECT_SOURCES).join(' '),
    'pricing connect-src must match index contract'
  );
  for (const page of ['welcome.html', 'pricing.html']) {
    assert.match(read(page, sourceRoot), /href="lib\/public\.css\?v=0\.16"/);
  }
  for (const page of LEGAL_PAGES) {
    assert.ok(fs.statSync(path.join(sourceRoot, page)).isFile(), page + ' must exist');
  }
}

function runLaunchCheck({ sourceRoot = DEFAULT_SOURCE_ROOT, origin = null } = {}) {
  const publicConfig = loadPublicConfig(sourceRoot);
  checkSourceShape(publicConfig, sourceRoot);
  const indexCsp = cspFrom(read('index.html', sourceRoot));
  const requestedOrigin = origin === null ? null : normaliseOrigin(origin);
  const effectiveOrigin = requestedOrigin || DEFAULT_ORIGIN;
  const runtime = resolveRuntime({ input: {}, csp: indexCsp, origin: effectiveOrigin, sourceRoot });
  const legalSources = LEGAL_PAGES.map((page) => read(page, sourceRoot));
  return Object.freeze({
    origin: effectiveOrigin,
    usedSyntheticOrigin: requestedOrigin === null,
    result: evaluateLaunch({
      publicConfig,
      runtime,
      legalSources,
      originRequired: requestedOrigin === null && runtimeNeedsExplicitOrigin(runtime)
    })
  });
}

function parseArgs(argv) {
  let origin = null;
  let sourceRoot = DEFAULT_SOURCE_ROOT;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      help = true;
      continue;
    }
    let key = arg;
    let value = null;
    const equals = arg.indexOf('=');
    if (equals > 0) {
      key = arg.slice(0, equals);
      value = arg.slice(equals + 1);
    }
    if (key === '--origin' || key === '--root') {
      if (value === null) value = argv[++i];
      if (!value) throw new Error(key + ' requires a value');
      if (key === '--origin') origin = normaliseOrigin(value);
      else sourceRoot = path.resolve(value);
      continue;
    }
    throw new Error('unknown option ' + arg);
  }
  return { origin, sourceRoot, help };
}

function main(argv = process.argv.slice(2), output = console) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      output.log('Usage: node Forex/tests/check-launch.js [--origin https://app.example] [--root fixture-directory]');
      return 0;
    }
    const check = runLaunchCheck(args);
    output.log('PASS: local public source and legal structure checks');
    output.log('LOCAL_SOURCE_STATUS=PASS');
    if (check.usedSyntheticOrigin) output.log('ORIGIN=synthetic local check only');
    else output.log('ORIGIN=' + check.origin);
    if (check.result.ready) {
      output.log('HOSTED_LAUNCH=SOURCE_READY: provider and browser verification remain separate gates');
      return 0;
    }
    check.result.blockers.forEach((blocker) => output.log('BLOCKER=' + blocker));
    output.log('HOSTED_LAUNCH=BLOCKED');
    return 2;
  } catch (error) {
    output.log('LOCAL_SOURCE_STATUS=BLOCKED');
    output.log('BLOCKER=' + (error && error.message ? error.message : 'launch check failed'));
    output.log('HOSTED_LAUNCH=BLOCKED');
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  APP_ONLY_CONNECT_SOURCES,
  DEFAULT_ORIGIN,
  LEGAL_PAGES,
  VM_TIMEOUT_MS,
  connectSources,
  evaluateLaunch,
  checkSourceShape,
  loadConfigApi,
  resolveRuntime,
  cspFrom,
  normaliseOrigin,
  runLaunchCheck,
  parseArgs,
  main
};
