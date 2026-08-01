// M7 STUB, not deployed. Stripe webhook seam for Kujira Forex.
// Syncs Stripe subscription events to profiles.plan in Supabase,
// the single source of truth for entitlements per SPEC.md section 12.
//
// Deploying needs Julian:
//   - A Stripe account with webhook endpoint configured to POST to this Worker's /webhook path
//   - A Forex Supabase project with a profiles table (stripe_customer_id, plan columns)
//   - Three secrets configured via `wrangler secret put`:
//     wrangler secret put STRIPE_WEBHOOK_SECRET     (from Stripe Dashboard)
//     wrangler secret put SB_URL                      (Supabase project URL)
//     wrangler secret put SB_SERVICE_ROLE_KEY         (Supabase service role key)
//   - Then deploy: `wrangler deploy`
//
// Plan mapping (profiles.plan values):
//   checkout.session.completed         → 'pro'
//   customer.subscription.updated      → 'pro' if status is active or trialing, else 'free'
//   customer.subscription.deleted      → 'free'
//   All other event types              → acknowledged and ignored (200 received)

// Constant-time string comparison for signatures.
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Update the user's plan in Supabase.
async function updateProfilePlan(env, customerId, plan) {
  if (!env.SB_URL || !env.SB_SERVICE_ROLE_KEY) {
    return {
      synced: false,
      reason: 'supabase not configured (stub)'
    };
  }

  const url = `${env.SB_URL}/rest/v1/profiles?stripe_customer_id=eq.${encodeURIComponent(customerId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': env.SB_SERVICE_ROLE_KEY,
      'Authorization': 'Bearer ' + env.SB_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ plan })
  });

  return {
    synced: res.ok,
    status: res.status
  };
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
    const parts = signatureHeader.split(',');
    let t = null;
    const v1Values = [];
    for (const part of parts) {
      const [key, value] = part.split('=');
      if (key === 't') {
        t = parseInt(value, 10);
      } else if (key === 'v1') {
        v1Values.push(value);
      }
    }

    if (t === null || v1Values.length === 0) {
      return new Response(
        JSON.stringify({ error: 'invalid signature' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check timestamp (must be within 300 seconds).
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - t) > 300) {
      return new Response(
        JSON.stringify({ error: 'invalid signature' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Compute HMAC-SHA256 of "t.rawBody" with the secret.
    const signedPayload = `${t}.${rawBody}`;
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

    // Determine plan and customer ID based on event type.
    let plan = null;
    let customerId = null;

    if (event.type === 'checkout.session.completed') {
      plan = 'pro';
      customerId = event.data.object.customer;
    } else if (event.type === 'customer.subscription.updated') {
      const status = event.data.object.status;
      plan = (status === 'active' || status === 'trialing') ? 'pro' : 'free';
      customerId = event.data.object.customer;
    } else if (event.type === 'customer.subscription.deleted') {
      plan = 'free';
      customerId = event.data.object.customer;
    } else {
      // Unhandled event type: acknowledged and ignored.
      return new Response(
        JSON.stringify({ received: true, ignored: event.type }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // If customer ID is missing, return without syncing.
    if (!customerId) {
      return new Response(
        JSON.stringify({ received: true, synced: false, reason: 'no customer id' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Sync to Supabase and return result.
    const result = await updateProfilePlan(env, customerId, plan);
    return new Response(
      JSON.stringify({ received: true, ...result }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
