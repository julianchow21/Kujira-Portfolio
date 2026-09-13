// M7 STUB, not deployed. Stripe webhook seam for Kujira Forex.
// Billing writes remain disabled unless an operator explicitly enables the
// configured price/product pair. Even then, the database RPC is the only
// mutation path, so event identity, ordering and profile attribution are
// decided atomically by the trusted database transaction.
//
// Deploying needs Julian:
//   - A Stripe account with webhook endpoint configured to POST to this Worker's /webhook path
//   - A Forex Supabase project with a server-owned profiles binding
//     (stripe_customer_id, stripe_subscription_id and plan columns)
//   - Three secrets configured via `wrangler secret put`:
//     wrangler secret put STRIPE_WEBHOOK_SECRET     (from Stripe Dashboard)
//     wrangler secret put SB_URL                      (Supabase project URL)
//     wrangler secret put SB_SERVICE_ROLE_KEY         (Supabase service role key)
//   - Then deploy: `wrangler deploy`
//
// Plan mapping is deliberately dormant. The operator must provide
// STRIPE_BILLING_ENABLED=true, STRIPE_PRO_PRICE_ID and STRIPE_PRO_PRODUCT_ID
// after completing the real Checkout customer-capture and event-delivery
// rollout. No price, product or customer IDs are embedded in this repository.

// Constant-time string comparison for signatures.
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

const BILLING_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);
const BILLING_ACTIVE_STATUSES = new Set(['active', 'trialing']);
const BILLING_FREE_STATUSES = new Set([
  'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'unpaid', 'paused'
]);

function billingConfig(env) {
  const priceId = env && typeof env.STRIPE_PRO_PRICE_ID === 'string'
    ? env.STRIPE_PRO_PRICE_ID.trim() : '';
  const productId = env && typeof env.STRIPE_PRO_PRODUCT_ID === 'string'
    ? env.STRIPE_PRO_PRODUCT_ID.trim() : '';
  if (!env || env.STRIPE_BILLING_ENABLED !== 'true') {
    return { enabled: false, reason: 'billing writes are disabled' };
  }
  if (!priceId || !productId) {
    return {
      enabled: false,
      reason: 'billing requires explicit STRIPE_PRO_PRICE_ID and STRIPE_PRO_PRODUCT_ID'
    };
  }
  return { enabled: true, priceId, productId };
}

function validEventIdentity(event) {
  return !!event
    && typeof event.id === 'string'
    && event.id.length > 0
    && event.id.length <= 255
    && event.id === event.id.trim()
    && !/[\u0000-\u001f\u007f]/.test(event.id)
    && Number.isSafeInteger(event.created)
    && event.created >= 0;
}

function eventObject(event) {
  return event && event.data && event.data.object && typeof event.data.object === 'object'
    ? event.data.object : null;
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

  let plan;
  if (event.type === 'checkout.session.completed') {
    if (object.mode !== 'subscription') {
      return { ok: false, status: 400, reason: 'checkout mode is not subscription' };
    }
    if (object.payment_status !== 'paid') {
      return { ok: false, status: 400, reason: 'checkout payment is not paid' };
    }
    if (typeof object.subscription !== 'string' || !object.subscription.trim()) {
      return { ok: false, status: 400, reason: 'checkout subscription is missing' };
    }
    if (typeof object.customer !== 'string' || !object.customer.trim()) {
      return { ok: false, status: 400, reason: 'checkout customer is missing' };
    }
    if (!config.enabled) return { ok: false, status: 503, reason: config.reason };
    if (!matchingRecurringPrice(object.line_items, config)) {
      return { ok: false, status: 400, reason: 'checkout price or product does not match configured plan' };
    }
    return {
      ok: false,
      status: 503,
      reason: 'checkout entitlement is disabled until a server-owned subscription binding is configured'
    };
  } else {
    if (typeof object.customer !== 'string' || !object.customer.trim()) {
      return { ok: false, status: 400, reason: 'subscription customer is missing' };
    }
    if (typeof object.id !== 'string' || !object.id.trim()) {
      return { ok: false, status: 400, reason: 'subscription ID is missing' };
    }
    if (!config.enabled) return { ok: false, status: 503, reason: config.reason };
    if (!matchingRecurringPrice(object.items, config)) {
      return { ok: false, status: 400, reason: 'subscription price or product does not match configured plan' };
    }
    if (event.type === 'customer.subscription.deleted') {
      if (object.status !== 'canceled') {
        return { ok: false, status: 400, reason: 'deleted subscription status is not canceled' };
      }
      plan = 'free';
    } else if (BILLING_ACTIVE_STATUSES.has(object.status)) plan = 'pro';
    else if (BILLING_FREE_STATUSES.has(object.status)) plan = 'free';
    else return { ok: false, status: 400, reason: 'subscription status is unsupported' };
  }

  return {
    ok: true,
    eventId: event.id,
    eventType: event.type,
    eventCreated: event.created,
    customerId: object.customer,
    subscriptionId: object.id,
    plan,
  };
}

// Stripe can include more than one v1 signature while an endpoint secret is
// being rotated. Keep the timestamp text exactly as received for the signed
// payload, and keep a parsed numeric copy only for the replay-window check.
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
      // Do not trim the timestamp value. Any whitespace would change the
      // signed text, so reject it rather than silently signing a different
      // representation from the header.
      if (timestamp !== null || !/^\d+$/.test(rawValue)) return null;
      const parsed = Number(rawValue);
      if (!Number.isSafeInteger(parsed)) return null;
      timestamp = rawValue;
      timestampSeconds = parsed;
    } else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value)) {
      v1Values.push(value.toLowerCase());
    }
    // Ignore v0 and unknown schemes. Stripe uses v0 for test events, and
    // official guidance says to verify only v1 to avoid downgrade attacks.
  }
  if (timestamp === null || !v1Values.length) return null;
  return { timestamp, timestampSeconds, v1Values };
}

// Update the user's plan through the atomic event fence in Supabase. Direct
// PATCH is intentionally absent, because checking Content-Range after a PATCH
// can discover a multi-row customer match only after all rows were mutated.
async function updateProfilePlan(env, customerId, plan, eventMeta) {
  if (!eventMeta
      || !validEventIdentity({ id: eventMeta.eventId, created: eventMeta.eventCreated })
      || typeof eventMeta.subscriptionId !== 'string'
      || !eventMeta.subscriptionId.trim()) {
    return { synced: false, status: 503, reason: 'billing event fence metadata is missing' };
  }
  const config = billingConfig(env);
  if (!config.enabled) return { synced: false, status: 503, reason: config.reason };
  if (!env.SB_URL || !env.SB_SERVICE_ROLE_KEY) {
    return {
      synced: false,
      status: 503,
      reason: 'supabase is not configured'
    };
  }

  const url = `${env.SB_URL}/rest/v1/rpc/apply_stripe_event`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': env.SB_SERVICE_ROLE_KEY,
      'Authorization': 'Bearer ' + env.SB_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      p_event_id: eventMeta.eventId,
      p_event_type: eventMeta.eventType,
      p_event_created: eventMeta.eventCreated,
      p_customer_id: customerId,
      p_subscription_id: eventMeta.subscriptionId,
      p_plan: plan,
    })
  });

  if (!res.ok) {
    return { synced: false, status: res.status, reason: 'billing event RPC failed' };
  }

  let payload;
  try {
    payload = await res.json();
  } catch (_) {
    return { synced: false, status: 503, reason: 'billing event RPC returned invalid JSON' };
  }
  if (!Array.isArray(payload) || payload.length !== 1) {
    return { synced: false, status: 503, reason: 'billing event RPC returned an invalid result' };
  }
  const row = payload[0];
  if (!row
      || typeof row.applied !== 'boolean'
      || typeof row.duplicate !== 'boolean'
      || (row.applied && row.duplicate)) {
    return { synced: false, status: 503, reason: 'billing event RPC returned an invalid result' };
  }
  const matched = Number.isSafeInteger(row.matched) ? row.matched : null;
  if (matched !== 1) {
    return { synced: false, status: 503, matched, reason: 'billing event RPC did not prove exactly one profile' };
  }
  if (row.duplicate) return { synced: true, duplicate: true, status: res.status, matched, reason: row.reason };
  if (row.applied) return { synced: true, status: res.status, matched, reason: row.reason };
  if (row.reason === 'stale event') return { synced: true, ignored: 'stale', status: res.status, matched, reason: row.reason };
  if (row.reason === 'ambiguous event ordering') return { synced: false, status: 409, matched, reason: row.reason };
  return { synced: false, status: 503, matched, reason: row.reason || 'profile attribution failed' };
}

export default {
  async fetch(request, env) {
    // Only POST to /webhook is accepted.
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/webhook') {
      return new Response(
        JSON.stringify({ error: 'not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check webhook secret is configured.
    if (!env.STRIPE_WEBHOOK_SECRET) {
      return new Response(
        JSON.stringify({ error: 'webhook secret not configured (stub)' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Read raw body FIRST, before any JSON parsing.
    // Stripe signs the raw bytes; this is load-bearing.
    const rawBody = await request.text();

    // Verify Stripe signature.
    const signatureHeader = request.headers.get('stripe-signature');
    if (!signatureHeader) {
      return new Response(
        JSON.stringify({ error: 'invalid signature' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Parse header: comma-separated k=v pairs.
    const parsedSignature = parseStripeSignature(signatureHeader);
    if (!parsedSignature) {
      return new Response(
        JSON.stringify({ error: 'invalid signature' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const { timestamp, timestampSeconds, v1Values } = parsedSignature;

    // Check timestamp (must be within 300 seconds).
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestampSeconds) > 300) {
      return new Response(
        JSON.stringify({ error: 'invalid signature' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Compute HMAC-SHA256 of "t.rawBody" with the secret.
    const signedPayload = `${timestamp}.${rawBody}`;
    const secretBytes = new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET);
    const payloadBytes = new TextEncoder().encode(signedPayload);

    const key = await crypto.subtle.importKey(
      'raw',
      secretBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, payloadBytes);
    const computed = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toLowerCase();

    // Verify against ANY v1 value (constant-time comparison).
    let signatureValid = false;
    for (const v1 of v1Values) {
      if (constantTimeEqual(computed, v1)) {
        signatureValid = true;
        break;
      }
    }

    if (!signatureValid) {
      return new Response(
        JSON.stringify({ error: 'invalid signature' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Parse event.
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'invalid signature' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const decision = billingEventDecision(event, env);
    if (decision.ignored) {
      // Unhandled event type: acknowledged and ignored.
      return new Response(
        JSON.stringify({ received: true, ignored: event.type }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (!decision.ok) {
      return new Response(
        JSON.stringify({ received: true, synced: false, reason: decision.reason }),
        { status: decision.status || 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Sync to Supabase through the event fence. Duplicate and stale events are
    // acknowledged only after the database proves that no mutation is needed.
    const result = await updateProfilePlan(env, decision.customerId, decision.plan, decision);
    const ok = !!result.synced;
    return new Response(
      JSON.stringify({ received: true, ...result }),
      { status: ok ? 200 : 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
