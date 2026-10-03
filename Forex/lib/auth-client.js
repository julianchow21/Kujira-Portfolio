/* Small adapter around the official supabase-js v2 UMD client.
 *
 * The SDK owns PKCE, refresh, URL callback handling and session persistence.
 * This file owns configuration validation, verified identity shape and the
 * narrow calls used by the Forex UI. It never contains a service-role secret.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else if (root) root.KjrForexAuth = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATES = Object.freeze({
    offline: 'offline',
    hosted: 'hosted',
    broken: 'broken',
    signedOut: 'signed-out',
    signedIn: 'signed-in',
    error: 'error'
  });

  class AuthClientError extends Error {
    constructor(code, message, cause) {
      super(message);
      this.name = 'AuthClientError';
      this.code = code;
      if (cause) this.cause = cause;
    }
  }

  function safeEmail(value) {
    return typeof value === 'string' && value.length <= 320 ? value : null;
  }

  function publicUser(user, local) {
    if (local) return { id: null, email: null, local: true };
    if (!user || typeof user.id !== 'string' || !user.id) {
      return { id: null, email: null, local: false, hosted: true, authenticated: false, scope: 'hosted-anonymous' };
    }
    return { id: user.id, email: safeEmail(user.email), local: false, hosted: true, authenticated: true, scope: 'user-' + user.id };
  }

  function errorFrom(result, fallbackCode, fallbackMessage) {
    if (!result) return new AuthClientError(fallbackCode, fallbackMessage);
    const err = result.error || result;
    const message = err && typeof err.message === 'string' ? err.message : fallbackMessage;
    return new AuthClientError(fallbackCode, message, err);
  }

  function createAuthClient(config, options) {
    options = options || {};
    const cfg = config || {};
    const sdk = options.sdk || (typeof globalThis !== 'undefined' ? globalThis.supabase : null);
    const locationLike = options.location || (typeof globalThis !== 'undefined' ? globalThis.location : null);
    let client = null;
    let current = cfg.mode === 'offline'
      ? publicUser(null, true)
      : publicUser(null, false);
    let status = cfg.mode === 'broken' ? STATES.broken : (cfg.mode === 'hosted' ? STATES.hosted : STATES.offline);
    let lastError = null;
    let session = null;
    let authGeneration = 0;
    const listeners = new Set();

    if (cfg.mode === 'hosted') {
      if (!sdk || typeof sdk.createClient !== 'function') {
        status = STATES.broken;
        lastError = new AuthClientError('sdk-unavailable', 'The configured Auth client is unavailable');
      } else {
        try {
          client = sdk.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
            auth: {
              persistSession: true,
              autoRefreshToken: true,
              detectSessionInUrl: true,
              flowType: 'pkce'
            }
          });
        } catch (e) {
          status = STATES.broken;
          lastError = new AuthClientError('sdk-init-failed', 'The configured Auth client could not start', e);
        }
      }
    }

    function emit(event, user) {
      listeners.forEach(listener => {
        try { listener({ event, user: user || current, status, error: lastError }); } catch (e) { /* a UI listener must not break Auth */ }
      });
    }

    function redirectTo() {
      if (cfg.authRedirectOrigin) return cfg.authRedirectOrigin + (locationLike && locationLike.pathname ? locationLike.pathname : '/Forex/');
      if (locationLike && locationLike.origin) return locationLike.origin + (locationLike.pathname || '/');
      return '';
    }

    function staleAuthError() {
      return new AuthClientError('auth-generation-changed', 'The Auth session changed while it was being verified');
    }

    async function verifiedSession(generation) {
      if (!client || !client.auth) throw new AuthClientError('auth-unavailable', 'Hosted Auth is unavailable');
      const sessionResult = await client.auth.getSession();
      if (sessionResult && sessionResult.error) throw errorFrom(sessionResult, 'session-failed', 'The Auth session could not be loaded');
      const capturedSession = sessionResult && sessionResult.data ? sessionResult.data.session || null : null;
      if (generation !== authGeneration) throw staleAuthError();
      if (!capturedSession) return { user: null, session: null };
      const capturedAccessToken = typeof capturedSession.access_token === 'string' ? capturedSession.access_token : '';
      if (!capturedAccessToken) throw new AuthClientError('session-token-missing', 'The verified Auth session has no access token');
      const capturedSessionUserId = capturedSession.user && typeof capturedSession.user.id === 'string' ? capturedSession.user.id : '';
      const userResult = await client.auth.getUser(capturedAccessToken);
      if (userResult && userResult.error) throw errorFrom(userResult, 'user-verification-failed', 'The Auth user could not be verified');
      if (generation !== authGeneration) throw staleAuthError();
      const user = userResult && userResult.data ? userResult.data.user || null : null;
      if (!user) throw new AuthClientError('user-verification-failed', 'The Auth user could not be verified');
      if (capturedSessionUserId && user.id !== capturedSessionUserId) {
        throw new AuthClientError('session-user-mismatch', 'The verified Auth user does not match the session');
      }
      return { user, session: capturedSession };
    }

    async function bootstrap() {
      if (cfg.mode === 'offline') {
        current = publicUser(null, true);
        status = STATES.offline;
        lastError = null;
        return current;
      }
      if (cfg.mode !== 'hosted' || !client) {
        current = publicUser(null, false);
        status = STATES.broken;
        throw lastError || new AuthClientError('auth-config', 'Hosted Auth is not configured');
      }
      const generation = ++authGeneration;
      try {
        const result = await verifiedSession(generation);
        if (generation !== authGeneration) throw staleAuthError();
        session = result.session;
        current = publicUser(result.user, false);
        status = current.authenticated ? STATES.signedIn : STATES.signedOut;
        lastError = null;
        return current;
      } catch (e) {
        if (e && e.code === 'auth-generation-changed') throw e;
        if (generation !== authGeneration) throw staleAuthError();
        session = null;
        current = publicUser(null, false);
        status = STATES.error;
        lastError = e instanceof AuthClientError ? e : new AuthClientError('auth-bootstrap-failed', 'Hosted Auth could not be verified', e);
        throw lastError;
      }
    }

    function onAuthStateChange(listener) {
      if (typeof listener !== 'function') return function () {};
      listeners.add(listener);
      let unsubscribe = function () { listeners.delete(listener); };
      if (client && client.auth && typeof client.auth.onAuthStateChange === 'function') {
        const subscription = client.auth.onAuthStateChange((event) => {
          if (event === 'SIGNED_OUT' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
            // Invalidate any in-flight verification and hide the previous user
            // before the app revalidates outside the SDK callback.
            authGeneration++;
            session = null;
            current = publicUser(null, false);
            status = event === 'SIGNED_OUT' ? STATES.signedOut : STATES.hosted;
            lastError = null;
            const changedUser = current;
            Promise.resolve().then(() => emit(event, changedUser));
          }
        });
        const sdkUnsubscribe = subscription && subscription.data && subscription.data.subscription && subscription.data.subscription.unsubscribe;
        const old = unsubscribe;
        unsubscribe = function () {
          old();
          if (typeof sdkUnsubscribe === 'function') sdkUnsubscribe.call(subscription.data.subscription);
        };
      }
      return unsubscribe;
    }

    function requireHosted() {
      if (!client || cfg.mode !== 'hosted') throw new AuthClientError('auth-unavailable', 'Hosted Auth is unavailable');
    }

    async function signInEmail(email, password) {
      requireHosted();
      const result = await client.auth.signInWithPassword({ email: String(email || '').trim(), password: String(password || '') });
      if (result && result.error) throw errorFrom(result, 'sign-in-failed', 'Sign-in failed');
      return bootstrap();
    }

    async function registerEmail(email, password) {
      requireHosted();
      const result = await client.auth.signUp({ email: String(email || '').trim(), password: String(password || ''), options: { emailRedirectTo: redirectTo() } });
      if (result && result.error) throw errorFrom(result, 'registration-failed', 'Registration failed');
      if (result && result.data && result.data.session) return bootstrap();
      authGeneration++;
      session = null;
      current = publicUser(null, false);
      status = STATES.signedOut;
      return { ...publicUser(null, false), pendingConfirmation: true };
    }

    async function sendMagicLink(email) {
      requireHosted();
      const result = await client.auth.signInWithOtp({ email: String(email || '').trim(), options: { emailRedirectTo: redirectTo() } });
      if (result && result.error) throw errorFrom(result, 'magic-link-failed', 'Magic link request failed');
      authGeneration++;
      session = null;
      current = publicUser(null, false);
      status = STATES.signedOut;
      return { ...publicUser(null, false), pendingConfirmation: true };
    }

    async function signInProvider(provider) {
      requireHosted();
      const name = String(provider || '').trim();
      if (!cfg.authProviders.includes(name)) throw new AuthClientError('provider-disabled', 'This sign-in provider is disabled');
      const result = await client.auth.signInWithOAuth({ provider: name, options: { redirectTo: redirectTo() } });
      if (result && result.error) throw errorFrom(result, 'oauth-failed', 'Provider sign-in failed');
      return result;
    }

    async function signOut() {
      requireHosted();
      const result = await client.auth.signOut({ scope: 'local' });
      if (result && result.error) throw errorFrom(result, 'sign-out-failed', 'Sign-out failed');
      authGeneration++;
      session = null;
      current = publicUser(null, false);
      status = STATES.signedOut;
      emit('SIGNED_OUT', current);
      return current;
    }

    async function headers() {
      if (cfg.mode !== 'hosted' || !current.authenticated || !session || !session.access_token) {
        throw new AuthClientError('session-required', 'An authenticated session is required');
      }
      return { 'Content-Type': 'application/json', 'apikey': cfg.supabaseAnonKey, 'Authorization': 'Bearer ' + session.access_token };
    }

    function snapshot() {
      return { user: { ...current }, status, error: lastError, session: session ? { access_token: session.access_token ? '[present]' : '' } : null };
    }

    return Object.freeze({
      states: STATES,
      config: cfg,
      client,
      bootstrap,
      onAuthStateChange,
      signInEmail,
      registerEmail,
      sendMagicLink,
      signInProvider,
      signOut,
      headers,
      currentUser: () => ({ ...current }),
      snapshot,
      getClient: () => client,
      redirectTo
    });
  }

  return Object.freeze({ STATES, AuthClientError, createAuthClient, publicUser });
}));
