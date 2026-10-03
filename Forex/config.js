/* Public Forex runtime configuration.
 *
 * This file may be shipped to a static host. It must contain public Supabase
 * URL and anon-key values only. Keep authentication disabled until a complete,
 * validated deployment configuration exists.
 */
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    authEnabled: false,
    supabaseUrl: '',
    supabaseAnonKey: '',
    workerUrl: '',
    // When billing is configured, this exact origin must also be present in
    // index.html's connect-src directive. Never use a wildcard here.
    workerConnectOrigin: '',
    authProviders: [],
    authRedirectOrigin: ''
  });

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function localHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]' || host === '::1';
  }

  function safeEndpoint(value, label, allowEmpty) {
    const raw = text(value);
    if (!raw && allowEmpty) return { value: '', error: '' };
    if (!raw) return { value: '', error: label + ' is required' };
    let url;
    try { url = new URL(raw); } catch (e) { return { value: '', error: label + ' is not a valid URL' }; }
    const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && localHost(url.hostname));
    if (!allowed) return { value: '', error: label + ' must use HTTPS' };
    if (url.username || url.password) return { value: '', error: label + ' must not contain credentials' };
    if (url.pathname && url.pathname !== '/') return { value: '', error: label + ' must be an origin without a path' };
    if (url.search || url.hash) return { value: '', error: label + ' must not contain a query or fragment' };
    return { value: url.origin.replace(/\/$/, ''), error: '' };
  }

  function providerList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(text).filter(v => /^[a-z][a-z0-9_-]{0,31}$/i.test(v)))];
  }

  function cspAllowsConnectOrigin(origin) {
    // Node contract tests do not have a document. The deployed page check
    // runs when the public CSP meta tag is present in the browser.
    if (typeof document === 'undefined' || !document.querySelector) return true;
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (!meta) return false;
    const policy = text(meta.getAttribute('content'));
    const match = /(?:^|;)\s*connect-src\s+([^;]+)/i.exec(policy);
    if(!match) return false;
    const sources=match[1].split(/\s+/);
    const sameOrigin=typeof location!=='undefined'&&location&&location.origin===origin;
    return sources.includes(origin)||(sameOrigin&&sources.includes("'self'"));
  }

  function resolve(input, locationLike) {
    const raw = Object.assign({}, DEFAULTS, (root && root.__KJR_FOREX_CONFIG__) || {}, input || {});
    const errors = [];
    const supabase = safeEndpoint(raw.supabaseUrl, 'Supabase URL', true);
    const worker = safeEndpoint(raw.workerUrl, 'Worker URL', true);
    const workerConnect = safeEndpoint(raw.workerConnectOrigin, 'Worker connect origin', true);
    const redirect = safeEndpoint(raw.authRedirectOrigin, 'Auth redirect origin', true);
    if (supabase.error) errors.push(supabase.error);
    if (worker.error) errors.push(worker.error);
    if (workerConnect.error) errors.push(workerConnect.error);
    if (redirect.error) errors.push(redirect.error);
    const anonKey = text(raw.supabaseAnonKey);
    if (raw.authEnabled && !supabase.value) errors.push('Supabase URL is required when Auth is enabled');
    if (raw.authEnabled && !anonKey) errors.push('Supabase anon key is required when Auth is enabled');
    if (worker.value && !workerConnect.value) errors.push('Worker URL requires an explicit Worker connect origin');
    if (!worker.value && workerConnect.value) errors.push('Worker connect origin requires a Worker URL');
    if (worker.value && workerConnect.value && worker.value !== workerConnect.value) {
      errors.push('Worker connect origin must exactly match the Worker URL origin');
    }
    if (workerConnect.value && !cspAllowsConnectOrigin(workerConnect.value)) {
      errors.push('Worker connect origin is not present in this page CSP');
    }
    if (redirect.value && locationLike && locationLike.origin && redirect.value !== locationLike.origin) {
      errors.push('Auth redirect origin must match the current origin');
    }
    const partial = !!(raw.authEnabled || text(raw.supabaseUrl) || anonKey || text(raw.workerUrl) || text(raw.workerConnectOrigin) || text(raw.authRedirectOrigin));
    const complete = !errors.length && !!supabase.value && !!anonKey;
    const mode = raw.authEnabled ? (complete ? 'hosted' : 'broken') : (partial && errors.length ? 'broken' : 'offline');
    return Object.freeze({
      authEnabled: mode === 'hosted',
      mode,
      supabaseUrl: supabase.value,
      supabaseAnonKey: anonKey,
      workerUrl: worker.value,
      workerConnectOrigin: workerConnect.value,
      authProviders: providerList(raw.authProviders),
      authRedirectOrigin: redirect.value,
      errors: Object.freeze(errors.slice()),
      complete
    });
  }

  const api = Object.freeze({ defaults: DEFAULTS, localHost, safeEndpoint, providerList, cspAllowsConnectOrigin, resolve });
  if (root) root.KjrForexConfig = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
