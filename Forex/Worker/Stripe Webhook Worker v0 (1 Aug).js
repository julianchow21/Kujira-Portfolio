// Kujira Forex billing Worker, local implementation candidate.
//
// This Worker owns the billing boundary. It accepts only Stripe test-mode
// configuration, exact server-owned price/product and redirect URLs, and
// authenticated Supabase users. The browser never supplies a Stripe customer,
// product, price, plan, user ID or redirect URL.
//
// Runtime secrets belong in Wrangler secrets, never vars or source:
//   STRIPE_SECRET_KEY       sk_test_...
//   STRIPE_WEBHOOK_SECRET   whsec_...
//   SB_URL                  https://<project>.supabase.co
//   SB_PUBLISHABLE_KEY      sb_publishable_... (or legacy SB_ANON_KEY)
//   SB_SERVICE_ROLE_KEY     legacy server-only key, or SB_SECRET_KEY
//
// Required billing vars when enabling checkout and portal:
//   STRIPE_BILLING_ENABLED=true
//   STRIPE_PRO_PRICE_ID, STRIPE_PRO_PRODUCT_ID
//   STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL, STRIPE_PORTAL_RETURN_URL
//   BILLING_ALLOWED_ORIGINS=https://<fixed-forex-origin>
//   STRIPE_API_VERSION=<operator-pinned Stripe API version>
//
// The Worker is not deployed by this file change. Hosted AI has no route here.

const MAX_API_BODY_BYTES = 16 * 1024;
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const FREE_TRADE_CAP = 50;
const ENTITLEMENT_KEYS = [
  'unlimited_trades',
  'simulator',
  'advanced_analytics',
  'ai_coach',
  'chart_markers',
  'csv_import',
];

// Supported entitlement transitions are paid Checkout completion plus the
// subscription lifecycle events whose current object can prove the plan.
// subscription.created and invoice events remain outside this contract,
// because initial access requires Checkout proof and invoice reconciliation is
// not implemented here.
const BILLING_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);
const BILLING_ACTIVE_STATUSES = new Set(['active', 'trialing']);
const BILLING_FREE_STATUSES = new Set([
  'canceled',
  'incomplete',
  'incomplete_expired',
  'past_due',
  'unpaid',
  'paused',
]);
const BILLING_CANCELABLE_STATUSES = new Set(['active', 'trialing']);
const PORTAL_ACTIONS = new Set(['manage', 'history', 'cancel']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // Object.prototype.toString also accepts JSON objects crossing a test or
  // Worker realm, while rejecting arrays, dates and other host objects.
  return Object.prototype.toString.call(value) === '[object Object]';
}

function safeId(value, max = 255) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value : '';
}

function safeUserId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value : '';
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

function safeHttpsOrigin(value) {
  const safe = safeHttpsUrl(value);
  if (!safe) return '';
  try {
    const url = new URL(safe);
    if (url.pathname !== '/' || url.search) return '';
    return url.origin;
  } catch (_) {
    return '';
  }
}

function safeSupabaseOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    // This Worker targets hosted Supabase project origins only. A credential,
    // path, query, port or fragment here could route bearer or service calls
    // outside the configured project.
    if (url.protocol !== 'https:' || url.username || url.password || url.port
        || url.pathname !== '/' || url.search || url.hash) return '';
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.supabase\.co$/.test(host)) return '';
    return url.origin;
  } catch (_) {
    return '';
  }
}

function safeStripeHostedUrl(value, kind) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const allowedHosts = kind === 'portal'
    ? new Set(['billing.stripe.com'])
    : new Set(['checkout.stripe.com']);
  try {
    const url = new URL(value.trim());
    // Stripe's current Checkout URL can contain a browser-only fragment,
    // so validate the known host without discarding that fragment.
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return allowedHosts.has(url.hostname) ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

function safeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const localHttp = url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(hostname);
    if (url.origin !== value.trim() || (url.protocol !== 'https:' && !localHttp)) return '';
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch (_) {
    return '';
  }
}

function allowedOrigins(env) {
  const raw = env && (env.BILLING_ALLOWED_ORIGINS || env.ALLOWED_ORIGINS || '');
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(',').map(safeOrigin).filter(Boolean))];
}

function serverKey(env) {
  const key = env && (env.SB_SECRET_KEY || env.SB_SERVICE_ROLE_KEY || '');
  return typeof key === 'string' ? key.trim() : '';
}

function serverAuth(env) {
  const secret = env && typeof env.SB_SECRET_KEY === 'string' ? env.SB_SECRET_KEY.trim() : '';
  if (secret) return { key: secret, jwt: false };
  const legacy = env && typeof env.SB_SERVICE_ROLE_KEY === 'string' ? env.SB_SERVICE_ROLE_KEY.trim() : '';
  if (legacy) return { key: legacy, jwt: true };
  return { key: '', jwt: false };
}

function publishableKey(env) {
  const key = env && (env.SB_PUBLISHABLE_KEY || env.SB_ANON_KEY || '');
  return typeof key === 'string' ? key.trim() : '';
}

function isStripeTestKey(value) {
  return typeof value === 'string' && /^sk_test_[A-Za-z0-9_]+$/.test(value);
}

function isStripePortalConfigurationId(value) {
  return typeof value === 'string' && /^bpc_[A-Za-z0-9]+$/.test(value);
}

function billingConfig(env) {
  const priceId = env && typeof env.STRIPE_PRO_PRICE_ID === 'string'
    ? env.STRIPE_PRO_PRICE_ID.trim() : '';
  const productId = env && typeof env.STRIPE_PRO_PRODUCT_ID === 'string'
    ? env.STRIPE_PRO_PRODUCT_ID.trim() : '';
  const stripeKey = env && typeof env.STRIPE_SECRET_KEY === 'string'
    ? env.STRIPE_SECRET_KEY.trim() : '';
  const sbUrl = safeSupabaseOrigin(env && env.SB_URL);
  // Keep production traffic pinned to Stripe's API origin. A test harness may
  // opt into a different HTTPS origin explicitly, but an arbitrary Worker var
  // must never be able to route the Stripe secret to an attacker-controlled URL.
  const testInjectionRequested = !!(env && env.STRIPE_TEST_INJECTION === 'true'
    && typeof env.STRIPE_TEST_API_BASE_URL === 'string');
  const injectedApiBase = testInjectionRequested
    ? safeHttpsOrigin(env.STRIPE_TEST_API_BASE_URL) : '';
  const apiBaseValid = !testInjectionRequested || !!injectedApiBase;
  const apiBase = injectedApiBase || 'https://api.stripe.com';
  const successUrl = safeHttpsUrl(env && env.STRIPE_SUCCESS_URL);
  const cancelUrl = safeHttpsUrl(env && env.STRIPE_CANCEL_URL);
  const portalReturnUrl = safeHttpsUrl(env && env.STRIPE_PORTAL_RETURN_URL);
  const portalConfigurationId = env && typeof env.STRIPE_PORTAL_CONFIGURATION_ID === 'string'
    ? env.STRIPE_PORTAL_CONFIGURATION_ID.trim() : '';
  const origins = allowedOrigins(env);
  const apiVersion = text(env && env.STRIPE_API_VERSION);

  if (!env || env.STRIPE_BILLING_ENABLED !== 'true') {
    return {
      enabled: false,
      apiReady: false,
      checkoutReady: false,
      origins,
      priceId,
      productId,
      stripeKey,
      sbUrl,
      apiBase,
      apiVersion,
      successUrl,
      cancelUrl,
      portalReturnUrl,
      portalConfigurationId,
      portalConfigurationValid: !portalConfigurationId || isStripePortalConfigurationId(portalConfigurationId),
      reason: 'billing writes are disabled',
    };
  }
  if (!priceId || !productId) {
    return {
      enabled: false,
      apiReady: false,
      checkoutReady: false,
      origins,
      priceId,
      productId,
      stripeKey,
      sbUrl,
      apiBase,
      apiVersion,
      successUrl,
      cancelUrl,
      portalReturnUrl,
      portalConfigurationId,
      portalConfigurationValid: !portalConfigurationId || isStripePortalConfigurationId(portalConfigurationId),
      reason: 'billing requires explicit STRIPE_PRO_PRICE_ID and STRIPE_PRO_PRODUCT_ID',
    };
  }

  const testKey = isStripeTestKey(stripeKey);
  const hasSupabase = !!sbUrl && !!publishableKey(env) && !!serverKey(env);
  const webhookSecret = env && typeof env.STRIPE_WEBHOOK_SECRET === 'string'
    ? env.STRIPE_WEBHOOK_SECRET.trim() : '';
  const fixedUrls = !!successUrl && !!cancelUrl && !!portalReturnUrl && origins.length > 0
    && [successUrl, cancelUrl, portalReturnUrl].every((value) => {
      try { return origins.includes(new URL(value).origin); } catch (_) { return false; }
    });
  let reason = '';
  if (stripeKey && !testKey) reason = 'billing requires a Stripe test-mode secret key';
  else if (!stripeKey) reason = 'billing provider is not configured';
  else if (!hasSupabase) reason = 'supabase billing service is not configured';
  else if (!fixedUrls) reason = 'billing requires fixed HTTPS URLs and an exact allowed origin';
  else if (!apiVersion) reason = 'billing requires an operator-pinned Stripe API version';
  else if (!apiBaseValid) reason = 'test provider URL is invalid';

  return {
    enabled: true,
    apiReady: testKey && hasSupabase && fixedUrls && !!apiVersion && apiBaseValid,
    checkoutReady: testKey && hasSupabase && fixedUrls && !!apiVersion && apiBaseValid && !!webhookSecret,
    origins,
    priceId,
    productId,
    stripeKey,
    sbUrl,
    apiBase,
    apiVersion,
    successUrl,
    cancelUrl,
    portalReturnUrl,
    portalConfigurationId,
    portalConfigurationValid: !portalConfigurationId || isStripePortalConfigurationId(portalConfigurationId),
    reason,
    testKey,
  };
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function jsonResponse(payload, status, origin, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function apiError(status, code, message, origin) {
  return jsonResponse({ error: message, code }, status, origin);
}

function webhookResponse(payload, status) {
  return jsonResponse(payload, status);
}

function requestHeader(request, name) {
  return request && request.headers && typeof request.headers.get === 'function'
    ? request.headers.get(name) : null;
}

function checkOrigin(request, env) {
  const origin = requestHeader(request, 'Origin');
  const origins = allowedOrigins(env);
  if (!origin || !origins.includes(origin)) {
    return { ok: false, origin: '', reason: 'origin is not allowed' };
  }
  return { ok: true, origin };
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function contentLengthTooLarge(request, limit) {
  const raw = requestHeader(request, 'Content-Length');
  if (raw === null) return false;
  return !/^\d+$/.test(raw.trim()) || Number(raw) > limit;
}

async function readLimitedText(request, limit) {
  if (contentLengthTooLarge(request, limit)) {
    const error = new Error('body too large');
    error.code = 'BODY_TOO_LARGE';
    throw error;
  }
  if (!request || typeof request.text !== 'function') {
    const error = new Error('request body is unavailable');
    error.code = 'INVALID_BODY';
    throw error;
  }

  // Cloudflare exposes the request body as a stream. Read it in bounded
  // chunks so a missing or false Content-Length cannot make the isolate hold
  // an unbounded ArrayBuffer before the size check.
  const body = request.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (!result || result.done) break;
        const value = result.value;
        if (!value || typeof value.byteLength !== 'number') {
          const error = new Error('request body is invalid');
          error.code = 'INVALID_BODY';
          throw error;
        }
        const chunk = value instanceof Uint8Array
          ? value : new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength);
        total += chunk.byteLength;
        if (total > limit) {
          try { await reader.cancel(); } catch (_) { /* body is already rejected */ }
          const error = new Error('body too large');
          error.code = 'BODY_TOO_LARGE';
          throw error;
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error && (error.code === 'BODY_TOO_LARGE' || error.code === 'INVALID_BODY')) throw error;
      const wrapped = new Error('request body is unavailable');
      wrapped.code = 'INVALID_BODY';
      throw wrapped;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    chunks.forEach((chunk) => {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    });
    if (typeof TextDecoder === 'function') return new TextDecoder().decode(bytes);
    return String.fromCharCode(...bytes);
  }

  if (typeof request.arrayBuffer !== 'function') {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > limit) {
      const error = new Error('body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    return raw;
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > limit) {
    const error = new Error('body too large');
    error.code = 'BODY_TOO_LARGE';
    throw error;
  }
  if (typeof TextDecoder === 'function') return new TextDecoder().decode(bytes);
  return String.fromCharCode(...new Uint8Array(bytes));
}

async function readJsonBody(request, limit, allowEmpty) {
  const raw = await readLimitedText(request, limit);
  if (!raw.trim()) {
    if (allowEmpty) return {};
    const error = new Error('JSON body is required');
    error.code = 'INVALID_BODY';
    throw error;
  }
  let value;
  try { value = JSON.parse(raw); } catch (_) {
    const error = new Error('JSON body is invalid');
    error.code = 'INVALID_BODY';
    throw error;
  }
  if (!isPlainObject(value)) {
    const error = new Error('JSON body must be an object');
    error.code = 'INVALID_BODY';
    throw error;
  }
  return value;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function parseBearer(request) {
  const value = requestHeader(request, 'Authorization');
  if (typeof value !== 'string' || !/^Bearer [^ ]+$/.test(value)) return '';
  const token = value.slice(7);
  if (!token || token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) return '';
  return token;
}

async function authenticateRequest(request, env) {
  const token = parseBearer(request);
  if (!token) return { ok: false, status: 401, code: 'auth_required', reason: 'authentication required' };
  const cfg = billingConfig(env);
  if (!cfg.sbUrl || !publishableKey(env)) {
    return { ok: false, status: 503, code: 'auth_unavailable', reason: 'authentication service is not configured' };
  }
  let response;
  try {
    response = await fetch(`${cfg.sbUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: publishableKey(env),
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (_) {
    return { ok: false, status: 503, code: 'auth_unavailable', reason: 'authentication service failed' };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status === 401 || response.status === 403 ? 401 : 503,
      code: response.status === 401 || response.status === 403 ? 'auth_invalid' : 'auth_unavailable',
      reason: response.status === 401 || response.status === 403 ? 'invalid access token' : 'authentication service failed',
    };
  }
  let payload;
  try { payload = await response.json(); } catch (_) {
    return { ok: false, status: 503, code: 'auth_unavailable', reason: 'authentication service returned invalid data' };
  }
  const user = payload && payload.user && typeof payload.user === 'object' ? payload.user : payload;
  const userId = safeUserId(user && user.id);
  if (!userId) {
    return { ok: false, status: 401, code: 'auth_invalid', reason: 'authenticated user identity is invalid' };
  }
  const email = typeof user.email === 'string' && user.email.length <= 320 ? user.email : '';
  return { ok: true, token, user: { id: userId, email } };
}

function rpcUrl(env, name) {
  const cfg = billingConfig(env);
  if (!cfg.sbUrl || !/^[a-z][a-z0-9_]{0,63}$/i.test(name)) return '';
  return `${cfg.sbUrl}/rest/v1/rpc/${name}`;
}

async function callRpc(env, name, body, options = {}) {
  const url = rpcUrl(env, name);
  const service = options.service ? serverAuth(env) : null;
  const key = options.service ? service.key : publishableKey(env);
  if (!url || !key || (options.service && !service.key)) {
    return { ok: false, status: 503, reason: 'database service is not configured' };
  }
  const headers = {
    apikey: key,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  if (options.service) {
    // New sb_secret_ keys are API keys, not JWTs. Supabase requires them on
    // apikey only. Legacy service_role keys remain supported with Bearer auth.
    if (service.jwt) headers.Authorization = `Bearer ${key}`;
  } else {
    headers.Authorization = `Bearer ${options.token || key}`;
  }
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
    });
  } catch (_) {
    return { ok: false, status: 503, reason: 'database service failed' };
  }
  if (!response.ok) {
    return { ok: false, status: response.status >= 400 && response.status < 500 ? 503 : 503, reason: 'database RPC failed' };
  }
  let payload;
  try { payload = await response.json(); } catch (_) {
    return { ok: false, status: 503, reason: 'database RPC returned invalid data' };
  }
  return { ok: true, status: response.status, payload };
}

function oneRpcRow(result) {
  if (!result || !result.ok || !Array.isArray(result.payload) || result.payload.length !== 1) return null;
  const row = result.payload[0];
  return isPlainObject(row) ? row : null;
}

async function fetchBillingProfile(auth, env) {
  const cfg = billingConfig(env);
  if (!cfg.sbUrl || !publishableKey(env)) return { ok: false, status: 503, reason: 'database service is not configured' };
  const url = `${cfg.sbUrl}/rest/v1/profiles?select=id,plan,stripe_customer_id,stripe_subscription_id&id=eq.${encodeURIComponent(auth.user.id)}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        apikey: publishableKey(env),
        Authorization: `Bearer ${auth.token}`,
      },
    });
  } catch (_) {
    return { ok: false, status: 503, reason: 'database service failed' };
  }
  if (!response.ok) return { ok: false, status: 503, reason: 'database profile read failed' };
  let payload;
  try { payload = await response.json(); } catch (_) {
    return { ok: false, status: 503, reason: 'database profile read returned invalid data' };
  }
  if (!Array.isArray(payload)) return { ok: false, status: 503, reason: 'database profile read returned invalid data' };
  if (payload.length === 0) return { ok: true, missing: true, profile: null };
  if (payload.length !== 1 || !isPlainObject(payload[0])) return { ok: false, status: 503, reason: 'database profile attribution failed' };
  const row = payload[0];
  if (row.id !== auth.user.id || !['free', 'pro'].includes(row.plan)) {
    return { ok: false, status: 503, reason: 'database profile attribution failed' };
  }
  const customerId = row.stripe_customer_id === null || row.stripe_customer_id === undefined
    ? '' : safeId(row.stripe_customer_id);
  if (row.stripe_customer_id && !customerId) return { ok: false, status: 503, reason: 'database profile binding is invalid' };
  const subscriptionId = row.stripe_subscription_id === null || row.stripe_subscription_id === undefined
    ? '' : safeId(row.stripe_subscription_id);
  if (row.stripe_subscription_id && !subscriptionId) return { ok: false, status: 503, reason: 'database subscription binding is invalid' };
  return { ok: true, missing: false, profile: { id: row.id, plan: row.plan, customerId, subscriptionId } };
}

function validEventIdentity(event) {
  return !!event
    && !!safeId(event.id)
    && Number.isSafeInteger(event.created)
    && event.created >= 0;
}

function eventObject(event) {
  return event && event.data && event.data.object && typeof event.data.object === 'object'
    ? event.data.object : null;
}

function stripeObjectId(value) {
  if (typeof value === 'string') return safeId(value);
  if (value && typeof value === 'object') return safeId(value.id);
  return '';
}

function matchingRecurringPrice(items, config) {
  const rows = items && Array.isArray(items.data) ? items.data : null;
  if (!rows || rows.length === 0 || items.has_more === true) return false;
  return rows.every((item) => {
    const price = item && item.price;
    const product = price && price.product;
    const productId = product && typeof product === 'object' ? product.id : product;
    return price
      && price.type === 'recurring'
      && price.id === config.priceId
      && productId === config.productId;
  });
}

function optionalMatchingRecurringPrice(items, config) {
  if (items === undefined) return true;
  return matchingRecurringPrice(items, config);
}

function subscriptionPlan(eventType, status) {
  if (eventType === 'customer.subscription.deleted') return status === 'canceled' ? 'free' : '';
  if (eventType === 'customer.subscription.paused') return status === 'paused' ? 'free' : '';
  if (eventType === 'customer.subscription.resumed') return BILLING_ACTIVE_STATUSES.has(status) ? 'pro' : '';
  if (BILLING_ACTIVE_STATUSES.has(status)) return 'pro';
  if (BILLING_FREE_STATUSES.has(status)) return 'free';
  return '';
}

function billingEventDecision(event, env) {
  if (!event || !BILLING_EVENT_TYPES.has(event.type)) {
    return { ignored: true, eventType: event && event.type };
  }
  if (!validEventIdentity(event)) {
    return { ok: false, status: 400, reason: 'event id and created timestamp are required' };
  }
  const config = billingConfig(env);
  const object = eventObject(event);
  if (!object) return { ok: false, status: 400, reason: 'event object is missing' };
  if (object.livemode !== false) return { ok: false, status: 400, reason: 'Stripe event is not an explicit test-mode event' };

  if (event.type === 'checkout.session.completed') {
    if (object.mode !== 'subscription') return { ok: false, status: 400, reason: 'checkout mode is not subscription' };
    if (object.payment_status !== 'paid') return { ok: false, status: 400, reason: 'checkout payment is not paid' };
    if (!stripeObjectId(object.subscription)) return { ok: false, status: 400, reason: 'checkout subscription is missing' };
    if (!stripeObjectId(object.customer)) return { ok: false, status: 400, reason: 'checkout customer is missing' };
    if (!stripeObjectId(object.id)) return { ok: false, status: 400, reason: 'checkout session ID is missing' };
    if (!config.enabled) return { ok: false, status: 503, reason: config.reason };
    if (object.line_items === undefined && !config.stripeKey) {
      return { ok: false, status: 400, reason: 'checkout price or product does not match configured plan' };
    }
    if (!optionalMatchingRecurringPrice(object.line_items, config)) {
      return { ok: false, status: 400, reason: 'checkout price or product does not match configured plan' };
    }
    return {
      ok: true,
      kind: 'checkout',
      eventId: event.id,
      eventType: event.type,
      eventCreated: event.created,
      customerId: stripeObjectId(object.customer),
      subscriptionId: stripeObjectId(object.subscription),
      sessionId: safeId(object.id),
      plan: 'pro',
    };
  }

  if (!stripeObjectId(object.customer)) {
    return { ok: false, status: 400, reason: 'subscription customer is missing' };
  }
  if (!stripeObjectId(object.id)) return { ok: false, status: 400, reason: 'subscription ID is missing' };
  if (!config.enabled) return { ok: false, status: 503, reason: config.reason };
  if (!matchingRecurringPrice(object.items, config)) {
    return { ok: false, status: 400, reason: 'subscription price or product does not match configured plan' };
  }

  const plan = subscriptionPlan(event.type, object.status);
  if (!plan) {
    return {
      ok: false,
      status: 400,
      reason: event.type === 'customer.subscription.deleted'
        ? 'deleted subscription status is not canceled' : 'subscription status is unsupported',
    };
  }

  return {
    ok: true,
    kind: 'subscription',
    eventId: event.id,
    eventType: event.type,
    eventCreated: event.created,
    customerId: stripeObjectId(object.customer),
    subscriptionId: stripeObjectId(object.id),
    plan,
  };
}

// Stripe can include more than one v1 signature while an endpoint secret is
// being rotated. Keep the timestamp text exactly as received for signed bytes.
function parseStripeSignature(header) {
  if (typeof header !== 'string' || !header.trim()) return null;
  let timestamp = null;
  let timestampSeconds = null;
  const v1Values = [];
  for (const rawPart of header.split(',')) {
    const equals = rawPart.indexOf('=');
    if (equals <= 0) continue;
    const key = rawPart.slice(0, equals).trim();
    const rawValue = rawPart.slice(equals + 1);
    const value = rawValue.trim();
    if (key === 't') {
      if (timestamp !== null || !/^\d+$/.test(rawValue)) return null;
      const parsed = Number(rawValue);
      if (!Number.isSafeInteger(parsed)) return null;
      timestamp = rawValue;
      timestampSeconds = parsed;
    } else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value)) {
      v1Values.push(value.toLowerCase());
    }
  }
  if (timestamp === null || !v1Values.length) return null;
  return { timestamp, timestampSeconds, v1Values };
}

async function verifyStripeSignature(rawBody, header, secret) {
  const parsed = parseStripeSignature(header);
  if (!parsed || !secret) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const signedPayload = `${parsed.timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return parsed.v1Values.some((value) => constantTimeEqual(computed, value));
}

function stripeForm(parameters) {
  const form = new URLSearchParams();
  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== null) form.set(key, String(value));
  });
  return form.toString();
}

async function stripeRequest(env, path, options = {}) {
  const config = billingConfig(env);
  if (!config.apiReady || !config.stripeKey) {
    return { ok: false, status: 503, reason: config.reason || 'billing provider is not configured' };
  }
  let url;
  try { url = new URL(path, `${config.apiBase}/`); } catch (_) {
    return { ok: false, status: 503, reason: 'billing provider URL is invalid' };
  }
  const method = options.method || 'GET';
  if (method === 'GET' && options.query && typeof options.query === 'object') {
    Object.entries(options.query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  }
  const headers = {
    Authorization: `Bearer ${config.stripeKey}`,
    Accept: 'application/json',
  };
  if (config.apiVersion) headers['Stripe-Version'] = config.apiVersion;
  const fetchOptions = { method, headers };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    fetchOptions.body = stripeForm(options.form || {});
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  }
  let response;
  try { response = await fetch(url.toString(), fetchOptions); } catch (_) {
    return { ok: false, status: 503, reason: 'billing provider failed' };
  }
  let payload = null;
  try { payload = await response.json(); } catch (_) { payload = null; }
  if (!response.ok) return { ok: false, status: 503, reason: 'billing provider rejected the request' };
  if (!isPlainObject(payload)) return { ok: false, status: 503, reason: 'billing provider returned invalid data' };
  return { ok: true, status: response.status, data: payload };
}

function idempotencyKey(prefix, userId, operationId) {
  const value = `${prefix}-${userId}-${operationId}`;
  return value.length <= 255 ? value : value.slice(0, 255);
}

function scopedIntentId(userId, operationId) {
  return `${userId}:${operationId}`;
}

function scopedIntentMatches(value, userId) {
  const prefix = `${userId}:`;
  if (!safeId(value, 255) || !value.startsWith(prefix)) return false;
  const operationId = value.slice(prefix.length);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(operationId);
}

function scopedCheckoutKeyMatches(value, userId) {
  const prefix = `checkout-${userId}-`;
  if (!safeId(value, 255) || !value.startsWith(prefix)) return false;
  const operationId = value.slice(prefix.length);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(operationId);
}

async function bindStripeCustomer(env, userId, customerId) {
  const result = await callRpc(env, 'bind_stripe_customer', {
    p_user_id: userId,
    p_customer_id: customerId,
  }, { service: true });
  const row = oneRpcRow(result);
  if (!row || typeof row.bound !== 'boolean' || typeof row.duplicate !== 'boolean'
      || !Number.isSafeInteger(row.matched) || row.matched !== 1) {
    return { ok: false, status: 503, reason: 'customer binding proof was invalid' };
  }
  if (!row.bound) return { ok: false, status: 409, reason: 'customer binding was rejected' };
  return { ok: true, duplicate: row.duplicate, reason: row.reason || 'bound' };
}

async function beginStripeCheckout(env, userId, intentId, key) {
  const result = await callRpc(env, 'begin_stripe_checkout', {
    p_user_id: userId,
    p_intent_id: intentId,
    p_idempotency_key: key,
  }, { service: true });
  const row = oneRpcRow(result);
  const intentProof = row && row.existing
    ? scopedIntentMatches(row.intent_id, userId)
    : row && row.intent_id === intentId;
  const keyProof = row && row.existing
    ? scopedCheckoutKeyMatches(row.idempotency_key, userId)
    : row && row.idempotency_key === key;
  if (!row || typeof row.accepted !== 'boolean' || typeof row.existing !== 'boolean'
      || !['pending', 'created', 'completed', 'expired', null].includes(row.status)
      || !intentProof
      || !keyProof
      || (row.session_id !== null && !safeId(row.session_id))
      || (row.customer_id !== null && !safeId(row.customer_id))
      || (row.idempotency_key !== null && !safeId(row.idempotency_key))) {
    return { ok: false, status: 503, reason: 'checkout reservation proof was invalid' };
  }
  if (!row.accepted) {
    return { ok: false, status: row.reason === 'already pro' ? 409 : 409, reason: row.reason || 'checkout reservation rejected' };
  }
  return {
    ok: true,
    existing: row.existing,
    intentId: row.intent_id || intentId,
    sessionId: row.session_id || '',
    customerId: row.customer_id || '',
    idempotencyKey: row.idempotency_key || key,
    status: row.status || 'pending',
    reason: row.reason || '',
  };
}

async function recordStripeCheckout(env, intentId, sessionId, customerId) {
  const result = await callRpc(env, 'record_stripe_checkout', {
    p_intent_id: intentId,
    p_session_id: sessionId,
    p_customer_id: customerId,
  }, { service: true });
  const row = oneRpcRow(result);
  if (!row || typeof row.recorded !== 'boolean' || typeof row.duplicate !== 'boolean') {
    return { ok: false, status: 503, reason: 'checkout record proof was invalid' };
  }
  if (!row.recorded) return { ok: false, status: 409, reason: row.reason || 'checkout record rejected' };
  return { ok: true, duplicate: row.duplicate, reason: row.reason || 'recorded' };
}

async function expireStripeCheckout(env, intentId, sessionId, customerId) {
  const result = await callRpc(env, 'expire_stripe_checkout', {
    p_intent_id: intentId,
    p_session_id: sessionId || null,
    p_customer_id: customerId,
  }, { service: true });
  const row = oneRpcRow(result);
  if (!row || typeof row.expired !== 'boolean' || typeof row.duplicate !== 'boolean') {
    return { ok: false, status: 503, reason: 'checkout expiry proof was invalid' };
  }
  if (row.duplicate) return { ok: true, duplicate: true, reason: row.reason || 'already expired' };
  if (!row.expired) return { ok: false, status: 409, reason: row.reason || 'checkout expiry was rejected' };
  return { ok: true, duplicate: false, reason: row.reason || 'expired' };
}

async function completeStripeCheckout(env, decision) {
  const result = await callRpc(env, 'complete_stripe_checkout', {
    p_event_id: decision.eventId,
    p_event_created: decision.eventCreated,
    p_customer_id: decision.customerId,
    p_subscription_id: decision.subscriptionId,
    p_session_id: decision.sessionId,
  }, { service: true });
  const row = oneRpcRow(result);
  if (!row || typeof row.applied !== 'boolean' || typeof row.duplicate !== 'boolean'
      || !Number.isSafeInteger(row.matched) || row.matched !== 1
      || (row.applied && row.duplicate)) {
    return { synced: false, status: 503, reason: 'checkout completion proof was invalid' };
  }
  if (row.duplicate) return { synced: true, duplicate: true, status: result.status, matched: row.matched, reason: row.reason || 'duplicate' };
  if (row.applied) return { synced: true, status: result.status, matched: row.matched, reason: row.reason || 'applied' };
  return { synced: false, status: 503, matched: row.matched, reason: row.reason || 'checkout completion rejected' };
}

// Update the user's plan through the atomic event fence in Supabase. Direct
// PATCH is intentionally absent, because customer attribution and ordering
// must be proven in one trusted database transaction.
async function updateProfilePlan(env, customerId, plan, eventMeta) {
  if (!eventMeta
      || !validEventIdentity({ id: eventMeta.eventId, created: eventMeta.eventCreated })
      || !safeId(eventMeta.subscriptionId)) {
    return { synced: false, status: 503, reason: 'billing event fence metadata is missing' };
  }
  const config = billingConfig(env);
  if (!config.enabled) return { synced: false, status: 503, reason: config.reason };
  if (!config.sbUrl || !serverKey(env)) return { synced: false, status: 503, reason: 'supabase is not configured' };

  const result = await callRpc(env, 'apply_stripe_event', {
    p_event_id: eventMeta.eventId,
    p_event_type: eventMeta.eventType,
    p_event_created: eventMeta.eventCreated,
    p_customer_id: customerId,
    p_subscription_id: eventMeta.subscriptionId,
    p_plan: plan,
  }, { service: true });
  if (!result.ok) return { synced: false, status: result.status || 503, reason: result.reason };
  const row = oneRpcRow(result);
  if (!row || typeof row.applied !== 'boolean' || typeof row.duplicate !== 'boolean'
      || (row.applied && row.duplicate)) {
    return { synced: false, status: 503, reason: 'billing event RPC returned an invalid result' };
  }
  const matched = Number.isSafeInteger(row.matched) ? row.matched : null;
  if (matched !== 1) return { synced: false, status: 503, matched, reason: 'billing event RPC did not prove exactly one profile' };
  if (row.duplicate) return { synced: true, duplicate: true, status: result.status, matched, reason: row.reason || 'duplicate' };
  if (row.applied) return { synced: true, status: result.status, matched, reason: row.reason || 'applied' };
  if (row.reason === 'stale event') return { synced: true, ignored: 'stale', status: result.status, matched, reason: row.reason };
  if (row.reason === 'ambiguous event ordering') return { synced: false, status: 503, matched, reason: row.reason };
  return { synced: false, status: 503, matched, reason: row.reason || 'profile attribution failed' };
}

async function accountCapabilities(auth, env) {
  const config = billingConfig(env);
  const capabilities = {
    portal_available: false,
    history_enabled: false,
    cancel_enabled: false,
  };
  if (!config.apiReady) return capabilities;
  const profileResult = await fetchBillingProfile(auth, env);
  if (!profileResult.ok || profileResult.missing || !profileResult.profile
      || !profileResult.profile.customerId) return capabilities;
  // Generic management can use Stripe's default portal configuration. The
  // history and cancellation actions require a server-pinned configuration
  // whose features are verified against the test provider first.
  capabilities.portal_available = true;
  if (!config.portalConfigurationId || !config.portalConfigurationValid) return capabilities;
  const portal = await retrieveStripePortalConfiguration(env, config.portalConfigurationId);
  if (!portal.ok) return capabilities;
  capabilities.history_enabled = portal.historyEnabled;
  if (!portal.cancelEnabled) return capabilities;
  const cancellation = await proveCancelableSubscription(env, profileResult.profile);
  capabilities.cancel_enabled = cancellation.ok;
  return capabilities;
}

function accountFromRow(row, config, capabilities = {}) {
  const plan = row && row.plan === 'pro' ? 'pro' : 'free';
  const tradeCount = row && Number.isSafeInteger(row.trade_count) && row.trade_count >= 0
    ? row.trade_count : 0;
  const tradeCap = plan === 'free'
    ? (row && Number.isSafeInteger(row.trade_cap) && row.trade_cap >= 0 ? row.trade_cap : FREE_TRADE_CAP)
    : null;
  const source = row && isPlainObject(row.entitlements) ? row.entitlements : {};
  const allowedFeatures = {};
  ENTITLEMENT_KEYS.forEach((key) => { allowedFeatures[key] = source[key] === true && plan === 'pro'; });
  const portalAvailable = capabilities.portal_available === true;
  const historyEnabled = capabilities.history_enabled === true;
  const cancelEnabled = capabilities.cancel_enabled === true;
  const billingStatus = row && typeof row.billing_status === 'string'
    && ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled', 'free', 'unknown']
      .includes(row.billing_status)
    ? row.billing_status : 'unknown';
  return {
    plan,
    trade_count: tradeCount,
    trade_cap: tradeCap,
    allowed_features: allowedFeatures,
    billing_status: billingStatus,
    billing_enabled: !!(config && config.apiReady),
    checkout_available: !!(config && config.checkoutReady && plan === 'free'),
    portal_available: portalAvailable,
    history_enabled: historyEnabled,
    cancel_enabled: cancelEnabled,
  };
}

async function accountState(auth, env) {
  const result = await callRpc(env, 'get_account_state', {}, { token: auth.token });
  if (!result.ok) return { ok: false, status: result.status || 503, reason: result.reason };
  if (!Array.isArray(result.payload)) return { ok: false, status: 503, reason: 'account state proof was invalid' };
  if (result.payload.length === 0) {
    // A trusted database bootstrap should create this row. A missing row gets
    // the safe free display while writes remain blocked by the database.
    return { ok: true, account: accountFromRow({ plan: 'free', trade_count: 0, trade_cap: FREE_TRADE_CAP, entitlements: {} }, billingConfig(env)) };
  }
  if (result.payload.length !== 1 || !isPlainObject(result.payload[0])) {
    return { ok: false, status: 503, reason: 'account state proof was invalid' };
  }
  const capabilities = await accountCapabilities(auth, env);
  return { ok: true, account: accountFromRow(result.payload[0], billingConfig(env), capabilities) };
}

async function authoriseFeature(auth, env, feature) {
  if (!ENTITLEMENT_KEYS.includes(feature)) return { ok: false, status: 400, reason: 'unknown feature' };
  const result = await callRpc(env, 'authorise_feature', { p_feature: feature }, { token: auth.token });
  const row = oneRpcRow(result);
  if (!row || typeof row.allowed !== 'boolean' || row.feature !== feature
      || !['free', 'pro'].includes(row.plan)) {
    return { ok: false, status: 503, reason: 'feature authorisation proof was invalid' };
  }
  return { ok: true, allowed: row.allowed, plan: row.plan, reason: row.reason || '' };
}

async function createStripeCustomer(env, auth) {
  // Customer identity is user-bound, so separate checkout attempts cannot
  // create separate Stripe customers during a race.
  const key = `customer-${auth.user.id}`;
  const result = await stripeRequest(env, '/v1/customers', {
    method: 'POST',
    idempotencyKey: key,
    form: {
      'metadata[forex_user_id]': auth.user.id,
    },
  });
  if (!result.ok) return result;
  const customerId = stripeObjectId(result.data && result.data.id);
  if (!customerId || !result.data || result.data.livemode !== false) {
    return { ok: false, status: 503, reason: 'billing provider returned an invalid customer' };
  }
  return { ok: true, customerId };
}

async function retrieveStripeCheckout(env, sessionId) {
  const result = await stripeRequest(env, `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'GET',
    query: {
      'expand[]': 'line_items',
    },
  });
  if (!result.ok) return result;
  const session = result.data;
  if (stripeObjectId(session.id) !== sessionId || session.livemode !== false) {
    return { ok: false, status: 503, reason: 'billing provider returned an invalid checkout session' };
  }
  return { ok: true, session };
}

async function retrieveStripeSubscription(env, subscriptionId) {
  const result = await stripeRequest(env, `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'GET',
    query: {
      'expand[]': 'items.data.price.product',
    },
  });
  if (!result.ok) return result;
  const subscription = result.data;
  if (stripeObjectId(subscription.id) !== subscriptionId || subscription.livemode !== false) {
    return { ok: false, status: 503, reason: 'billing provider returned an invalid subscription' };
  }
  return { ok: true, subscription };
}

function portalFeatureEnabled(configuration, feature) {
  const features = configuration && configuration.features;
  const value = features && features[feature];
  return isPlainObject(value) && value.enabled === true;
}

async function retrieveStripePortalConfiguration(env, configurationId) {
  const config = billingConfig(env);
  if (!config.portalConfigurationId || !config.portalConfigurationValid
      || configurationId !== config.portalConfigurationId) {
    return { ok: false, status: 503, reason: 'billing portal configuration is invalid' };
  }
  const result = await stripeRequest(env, `/v1/billing_portal/configurations/${encodeURIComponent(configurationId)}`, {
    method: 'GET',
  });
  if (!result.ok) return { ok: false, status: result.status || 503, reason: 'billing portal configuration could not be verified' };
  const portal = result.data;
  if (!isPlainObject(portal)
      || stripeObjectId(portal.id) !== configurationId
      || portal.livemode !== false
      || portal.active !== true) {
    return { ok: false, status: 503, reason: 'billing portal configuration proof was invalid' };
  }
  return {
    ok: true,
    configuration: portal,
    historyEnabled: portalFeatureEnabled(portal, 'invoice_history'),
    cancelEnabled: portalFeatureEnabled(portal, 'subscription_cancel'),
  };
}

function cancelableSubscriptionProof(subscription, profile, config) {
  if (!subscription || !profile || !profile.customerId || !profile.subscriptionId) {
    return { ok: false, reason: 'subscription cancellation is unavailable' };
  }
  if (stripeObjectId(subscription.id) !== profile.subscriptionId
      || stripeObjectId(subscription.customer) !== profile.customerId
      || subscription.livemode !== false
      || !matchingRecurringPrice(subscription.items, config)) {
    return { ok: false, reason: 'subscription binding could not be verified' };
  }
  if (subscription.status === 'canceled'
      || subscription.cancel_at_period_end === true
      || (subscription.cancel_at !== null && subscription.cancel_at !== undefined)) {
    return { ok: false, reason: 'subscription is already cancelled' };
  }
  if (!BILLING_CANCELABLE_STATUSES.has(subscription.status)) {
    return { ok: false, reason: 'subscription cancellation is unavailable for its current status' };
  }
  return { ok: true };
}

async function proveCancelableSubscription(env, profile) {
  const config = billingConfig(env);
  if (!profile || !profile.customerId || !profile.subscriptionId) {
    return { ok: false, status: 409, reason: 'subscription cancellation is unavailable' };
  }
  const result = await retrieveStripeSubscription(env, profile.subscriptionId);
  if (!result.ok) return { ok: false, status: result.status || 503, reason: 'current subscription could not be verified' };
  const proof = cancelableSubscriptionProof(result.subscription, profile, config);
  if (!proof.ok) return { ok: false, status: 409, reason: proof.reason };
  return { ok: true, subscription: result.subscription };
}

async function proveCheckoutSession(env, decision, eventObjectValue) {
  const config = billingConfig(env);
  if (!config.apiReady) {
    const reason = !config.stripeKey
      ? 'checkout entitlement is disabled until a server-owned subscription binding is configured'
      : (config.reason || 'billing provider is not configured');
    return { ok: false, status: 503, reason };
  }
  const sessionResult = await retrieveStripeCheckout(env, decision.sessionId);
  if (!sessionResult.ok) return sessionResult;
  const session = sessionResult.session;
  const eventCustomer = decision.customerId;
  const eventSubscription = decision.subscriptionId;
  if (stripeObjectId(session.customer) !== eventCustomer
      || stripeObjectId(session.subscription) !== eventSubscription
      || session.mode !== 'subscription'
      || session.payment_status !== 'paid'
      || session.status !== 'complete') {
    return { ok: false, status: 400, reason: 'checkout session proof did not match the signed event' };
  }
  if (!optionalMatchingRecurringPrice(session.line_items, config)) {
    return { ok: false, status: 400, reason: 'checkout price or product does not match configured plan' };
  }
  const subscriptionResult = await retrieveStripeSubscription(env, eventSubscription);
  if (!subscriptionResult.ok) return subscriptionResult;
  const subscription = subscriptionResult.subscription;
  if (stripeObjectId(subscription.customer) !== eventCustomer
      || !BILLING_ACTIVE_STATUSES.has(subscription.status)
      || !matchingRecurringPrice(subscription.items, config)) {
    return { ok: false, status: 400, reason: 'checkout subscription is not paid and active' };
  }
  if (eventObjectValue && eventObjectValue.livemode !== false) {
    return { ok: false, status: 400, reason: 'live-mode Stripe event is not accepted' };
  }
  return { ok: true, session, subscription };
}

async function processCheckoutWebhook(env, decision, eventObjectValue) {
  const proof = await proveCheckoutSession(env, decision, eventObjectValue);
  if (!proof.ok) return { synced: false, status: proof.status || 503, reason: proof.reason };
  return completeStripeCheckout(env, decision);
}

async function processSubscriptionWebhook(env, event, decision) {
  const config = billingConfig(env);
  // A signed event proves origin, but it cannot prove that this Worker is
  // operating against the configured test account. Require the server-owned
  // test key before any subscription can change entitlement.
  if (!config.testKey || !config.apiReady) {
    return { synced: false, status: 503, reason: config.reason || 'billing provider is not configured' };
  }
  const current = await retrieveStripeSubscription(env, decision.subscriptionId);
  if (!current.ok) return { synced: false, status: current.status || 503, reason: current.reason };
  const subscription = current.subscription;
  if (stripeObjectId(subscription.customer) !== decision.customerId
      || subscription.livemode !== false
      || !matchingRecurringPrice(subscription.items, config)) {
    return { synced: false, status: 400, reason: 'current subscription proof did not match the signed event' };
  }
  const currentPlan = subscriptionPlan(event.type, subscription.status);
  if (!currentPlan) {
    return { synced: false, status: 400, reason: 'current subscription status is unsupported' };
  }
  // Keep the signed event ID, type and timestamp as the database fence
  // identity. If Stripe has since delivered a different state, acknowledge
  // only after the current state is durably recorded. Returning 503 makes
  // Stripe retry this event, rather than silently dropping a transition when
  // the newer lifecycle event has not reached this endpoint yet.
  if (currentPlan !== decision.plan) {
    return {
      synced: false,
      ignored: 'subscription_changed',
      status: 503,
      reason: 'current subscription state differs from the signed event',
    };
  }
  return updateProfilePlan(env, decision.customerId, decision.plan, decision);
}

async function handleCheckout(request, env, auth, origin) {
  const config = billingConfig(env);
  if (!config.enabled) return apiError(503, 'billing_disabled', config.reason, origin);
  if (!config.checkoutReady) return apiError(503, 'checkout_unavailable', config.reason || 'checkout is not configured', origin);
  let body;
  try { body = await readJsonBody(request, MAX_API_BODY_BYTES, false); }
  catch (error) {
    return apiError(error.code === 'BODY_TOO_LARGE' ? 413 : 400, error.code === 'BODY_TOO_LARGE' ? 'body_too_large' : 'invalid_body', error.message, origin);
  }
  if (!exactKeys(body, ['operation_id']) || !safeId(body.operation_id, 128)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(body.operation_id)) {
    return apiError(400, 'invalid_operation', 'operation_id is required and must be a bounded identifier', origin);
  }
  const operationId = body.operation_id;
  const intentId = scopedIntentId(auth.user.id, operationId);
  if (!safeId(intentId, 255)) {
    return apiError(400, 'invalid_operation', 'operation_id is too long for a checkout intent', origin);
  }
  const profileResult = await fetchBillingProfile(auth, env);
  if (!profileResult.ok) return apiError(profileResult.status, 'profile_unavailable', profileResult.reason, origin);
  if (profileResult.missing || !profileResult.profile) return apiError(503, 'profile_unavailable', 'account profile is not initialised', origin);
  if (profileResult.profile.plan === 'pro') return apiError(409, 'already_pro', 'account already has Pro access', origin);
  if (profileResult.profile.subscriptionId) {
    if (!profileResult.profile.customerId) {
      return apiError(503, 'subscription_binding_failed', 'stored subscription has no customer binding', origin);
    }
    const current = await retrieveStripeSubscription(env, profileResult.profile.subscriptionId);
    if (!current.ok) return apiError(current.status || 503, 'subscription_retrieval_failed', current.reason, origin);
    if (stripeObjectId(current.subscription.customer) !== profileResult.profile.customerId) {
      return apiError(503, 'subscription_binding_failed', 'stored subscription did not match the customer binding', origin);
    }
    if (current.subscription.status !== 'canceled') {
      return apiError(409, 'subscription_recovery_required', 'an existing subscription needs recovery in the billing portal', origin);
    }
  }

  const reservation = await beginStripeCheckout(
    env,
    auth.user.id,
    intentId,
    idempotencyKey('checkout', auth.user.id, operationId),
  );
  if (!reservation.ok) return apiError(reservation.status, 'checkout_reservation_failed', reservation.reason, origin);
  if ((reservation.sessionId && !['created', 'completed'].includes(reservation.status))
      || (!reservation.sessionId && ['created', 'completed'].includes(reservation.status))) {
    return apiError(503, 'checkout_reservation_failed', 'checkout reservation proof was inconsistent', origin);
  }
  const reservedIntentId = reservation.intentId;
  if (!scopedIntentMatches(reservedIntentId, auth.user.id)
      || (!reservation.existing && reservedIntentId !== intentId)
      || (reservation.existing && !scopedCheckoutKeyMatches(reservation.idempotencyKey, auth.user.id))) {
    return apiError(503, 'checkout_reservation_failed', 'checkout reservation intent did not match the authenticated user', origin);
  }
  const checkoutKey = reservation.idempotencyKey;
  let customerId = reservation.customerId || profileResult.profile.customerId;
  if (reservation.customerId && profileResult.profile.customerId && reservation.customerId !== profileResult.profile.customerId) {
    return apiError(503, 'customer_binding_failed', 'customer binding proof did not match the profile', origin);
  }
  if (!customerId) {
    const customer = await createStripeCustomer(env, auth);
    if (!customer.ok) return apiError(customer.status || 503, 'customer_create_failed', customer.reason, origin);
    customerId = customer.customerId;
    const binding = await bindStripeCustomer(env, auth.user.id, customerId);
    if (!binding.ok) return apiError(binding.status || 503, 'customer_binding_failed', binding.reason, origin);
  }

  if (reservation.sessionId && ['created', 'completed'].includes(reservation.status)) {
    const existing = await retrieveStripeCheckout(env, reservation.sessionId);
    if (!existing.ok) return apiError(existing.status || 503, 'checkout_retrieval_failed', existing.reason, origin);
    if (stripeObjectId(existing.session.customer) !== customerId || existing.session.mode !== 'subscription') {
      return apiError(503, 'checkout_binding_failed', 'stored checkout session did not match the customer', origin);
    }
    if (existing.session.status === 'expired') {
      const expiry = await expireStripeCheckout(env, reservedIntentId, reservation.sessionId, customerId);
      if (!expiry.ok) return apiError(expiry.status || 503, 'checkout_expiry_failed', expiry.reason, origin);
      return apiError(409, 'checkout_expired', 'checkout session expired, retry with a new operation', origin);
    }
    if (!['open', 'complete'].includes(existing.session.status)) {
      return apiError(503, 'checkout_retrieval_failed', 'stored checkout session has an unsupported status', origin);
    }
    if (typeof existing.session.url !== 'string' || !safeStripeHostedUrl(existing.session.url, 'checkout')) {
      return apiError(503, 'checkout_retrieval_failed', 'stored checkout session URL is invalid', origin);
    }
    return jsonResponse({ checkout_url: existing.session.url, session_id: reservation.sessionId }, 200, origin);
  }

  const session = await stripeRequest(env, '/v1/checkout/sessions', {
    method: 'POST',
    idempotencyKey: checkoutKey,
    form: {
      mode: 'subscription',
      'line_items[0][price]': config.priceId,
      'line_items[0][quantity]': '1',
      customer: customerId,
      client_reference_id: reservedIntentId,
      'metadata[forex_user_id]': auth.user.id,
      'metadata[intent_id]': reservedIntentId,
      'subscription_data[metadata][forex_user_id]': auth.user.id,
      'subscription_data[metadata][intent_id]': reservedIntentId,
      success_url: config.successUrl,
      cancel_url: config.cancelUrl,
    },
  });
  if (!session.ok) return apiError(session.status || 503, 'checkout_create_failed', session.reason, origin);
  const sessionId = stripeObjectId(session.data && session.data.id);
  const returnedCustomer = stripeObjectId(session.data && session.data.customer);
  const sessionUrl = safeStripeHostedUrl(session.data && session.data.url, 'checkout');
  if (!sessionId || returnedCustomer !== customerId || !sessionUrl
      || session.data.mode !== 'subscription' || session.data.livemode !== false) {
    return apiError(503, 'checkout_create_failed', 'billing provider returned an invalid checkout session', origin);
  }
  const recorded = await recordStripeCheckout(env, reservedIntentId, sessionId, customerId);
  if (!recorded.ok) return apiError(recorded.status || 503, 'checkout_record_failed', recorded.reason, origin);
  return jsonResponse({ checkout_url: sessionUrl, session_id: sessionId }, 200, origin);
}

async function handlePortal(request, env, auth, origin) {
  const config = billingConfig(env);
  if (!config.enabled) return apiError(503, 'billing_disabled', config.reason, origin);
  if (!config.apiReady) return apiError(503, 'billing_unavailable', config.reason || 'billing provider is not configured', origin);
  let body;
  try { body = await readJsonBody(request, MAX_API_BODY_BYTES, true); }
  catch (error) {
    return apiError(error.code === 'BODY_TOO_LARGE' ? 413 : 400, error.code === 'BODY_TOO_LARGE' ? 'body_too_large' : 'invalid_body', error.message, origin);
  }
  let action = 'manage';
  if (!exactKeys(body, [])) {
    if (!exactKeys(body, ['action']) || typeof body.action !== 'string' || !PORTAL_ACTIONS.has(body.action)) {
      return apiError(400, 'invalid_body', 'portal action must be manage, history or cancel', origin);
    }
    action = body.action;
  }
  const profileResult = await fetchBillingProfile(auth, env);
  if (!profileResult.ok) return apiError(profileResult.status, 'profile_unavailable', profileResult.reason, origin);
  const customerId = profileResult.profile && profileResult.profile.customerId;
  if (!customerId) return apiError(409, 'billing_customer_missing', 'billing customer is not configured', origin);
  let portalConfiguration = null;
  if (action !== 'manage') {
    if (!config.portalConfigurationId) {
      return apiError(503, 'portal_configuration_required', 'this billing action is not configured', origin);
    }
    if (!config.portalConfigurationValid) {
      return apiError(503, 'portal_configuration_invalid', 'this billing action is not configured', origin);
    }
    const configurationResult = await retrieveStripePortalConfiguration(env, config.portalConfigurationId);
    if (!configurationResult.ok) {
      return apiError(configurationResult.status || 503, 'portal_configuration_unavailable', configurationResult.reason, origin);
    }
    if (action === 'history' && !configurationResult.historyEnabled) {
      return apiError(503, 'billing_history_unavailable', 'billing history is not enabled', origin);
    }
    if (action === 'cancel' && !configurationResult.cancelEnabled) {
      return apiError(503, 'subscription_cancel_unavailable', 'subscription cancellation is not enabled', origin);
    }
    portalConfiguration = configurationResult;
  }
  let cancellation = null;
  if (action === 'cancel') {
    cancellation = await proveCancelableSubscription(env, profileResult.profile);
    if (!cancellation.ok) {
      return apiError(cancellation.status || 409, 'subscription_cancel_unavailable', cancellation.reason, origin);
    }
  }
  const suppliedKey = requestHeader(request, 'Idempotency-Key');
  const portalKey = suppliedKey && /^[A-Za-z0-9._:-]{8,200}$/.test(suppliedKey)
    ? `portal-${auth.user.id}-${action}-${suppliedKey}`
    : `portal-${auth.user.id}-${action}-${crypto.randomUUID()}`;
  const form = {
    customer: customerId,
    return_url: config.portalReturnUrl,
  };
  if (portalConfiguration) {
    form.configuration = config.portalConfigurationId;
  }
  if (action === 'cancel') {
    form['flow_data[type]'] = 'subscription_cancel';
    form['flow_data[subscription_cancel][subscription]'] = profileResult.profile.subscriptionId;
    form['flow_data[after_completion][type]'] = 'hosted_confirmation';
  }
  const result = await stripeRequest(env, '/v1/billing_portal/sessions', {
    method: 'POST',
    idempotencyKey: portalKey,
    form,
  });
  if (!result.ok) return apiError(result.status || 503, 'portal_create_failed', result.reason, origin);
  const returnedCustomer = stripeObjectId(result.data && result.data.customer);
  const portalUrl = safeStripeHostedUrl(result.data && result.data.url, 'portal');
  const returnedConfiguration = stripeObjectId(result.data && result.data.configuration);
  if (returnedCustomer !== customerId || !portalUrl || result.data.livemode !== false
      || (portalConfiguration && returnedConfiguration !== config.portalConfigurationId)) {
    return apiError(503, 'portal_create_failed', 'billing provider returned an invalid portal session', origin);
  }
  return jsonResponse({ portal_url: portalUrl }, 200, origin);
}

async function handleAccount(request, env, auth, origin) {
  const result = await accountState(auth, env);
  if (!result.ok) return apiError(result.status || 503, 'account_state_failed', result.reason, origin);
  return jsonResponse(result.account, 200, origin);
}

async function handleApi(request, env, pathname) {
  const originCheck = checkOrigin(request, env);
  if (!originCheck.ok) return apiError(403, 'origin_denied', originCheck.reason, '');
  const origin = originCheck.origin;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  const auth = await authenticateRequest(request, env);
  if (!auth.ok) return apiError(auth.status, auth.code, auth.reason, origin);
  if (pathname === '/account') {
    if (request.method !== 'GET') return apiError(405, 'method_not_allowed', 'GET is required', origin);
    try {
      const rawBody = await readLimitedText(request, 0);
      if (rawBody.trim()) return apiError(400, 'invalid_body', 'account body must be empty', origin);
    } catch (_) {
      return apiError(400, 'invalid_body', 'account body must be empty', origin);
    }
    return handleAccount(request, env, auth, origin);
  }
  if (pathname === '/checkout') {
    if (request.method !== 'POST') return apiError(405, 'method_not_allowed', 'POST is required', origin);
    return handleCheckout(request, env, auth, origin);
  }
  if (pathname === '/portal') {
    if (request.method !== 'POST') return apiError(405, 'method_not_allowed', 'POST is required', origin);
    return handlePortal(request, env, auth, origin);
  }
  return apiError(404, 'not_found', 'not found', origin);
}

async function handleWebhook(request, env) {
  if (request.method !== 'POST') return webhookResponse({ error: 'method not allowed' }, 405);
  const secret = env && typeof env.STRIPE_WEBHOOK_SECRET === 'string' ? env.STRIPE_WEBHOOK_SECRET.trim() : '';
  if (!secret) return webhookResponse({ error: 'webhook secret not configured' }, 503);
  let rawBody;
  try { rawBody = await readLimitedText(request, MAX_WEBHOOK_BODY_BYTES); }
  catch (error) {
    return webhookResponse({ error: error.code === 'BODY_TOO_LARGE' ? 'body too large' : 'invalid body' }, error.code === 'BODY_TOO_LARGE' ? 413 : 400);
  }
  if (!await verifyStripeSignature(rawBody, requestHeader(request, 'stripe-signature'), secret)) {
    return webhookResponse({ error: 'invalid signature' }, 400);
  }
  let event;
  try { event = JSON.parse(rawBody); } catch (_) {
    return webhookResponse({ error: 'invalid signature' }, 400);
  }
  const decision = billingEventDecision(event, env);
  if (decision.ignored) return webhookResponse({ received: true, ignored: decision.eventType }, 200);
  if (!decision.ok) return webhookResponse({ received: true, synced: false, reason: decision.reason }, decision.status || 503);

  try {
    let result;
    if (decision.kind === 'checkout') result = await processCheckoutWebhook(env, decision, eventObject(event));
    else result = await processSubscriptionWebhook(env, event, decision);
    const ok = !!result.synced;
    return webhookResponse({ received: true, ...result }, ok ? 200 : (result.status || 503));
  } catch (_) {
    return webhookResponse({ received: true, synced: false, reason: 'billing provider or database failure' }, 503);
  }
}

export default {
  async fetch(request, env) {
    let url;
    try { url = new URL(request.url); } catch (_) {
      return jsonResponse({ error: 'invalid request URL' }, 400, '');
    }
    if (url.pathname === '/webhook') return handleWebhook(request, env || {});
    if (url.pathname === '/checkout' || url.pathname === '/portal' || url.pathname === '/account') {
      return handleApi(request, env || {}, url.pathname);
    }
    return jsonResponse({ error: 'not found' }, 404, '');
  },
};
