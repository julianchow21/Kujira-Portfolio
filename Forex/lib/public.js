/* Public preview and pricing page helpers, kept dependency-free and fail-closed. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (root) root.KjrPublic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_SIGNUP = './index.html#signup';
  const DEFAULT_SIGNIN = './index.html#account';
  const DEFAULT_FEATURES = Object.freeze([
    'Unlimited trades',
    'Advanced review',
    'Simulator',
    'Chart markers',
    'CSV import'
  ]);
  const FALLBACK_CURRENCIES = new Set([
    'AUD', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'HKD', 'JPY', 'NZD', 'SGD', 'USD'
  ]);

  function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function text(value, max) {
    if (typeof value !== 'string') return '';
    const out = value.trim();
    return out.length <= max ? out : '';
  }

  function safeRelativeHref(value, fallback) {
    const out = text(value, 240);
    if (!out || /[\u0000-\u001f\u007f]/.test(out)
      || /[<>"'`]/.test(out)
      || !out.startsWith('./')
      || /^\/\//.test(out)
      || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(out)) {
      return fallback;
    }
    return out;
  }

  function amount(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const number = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(number) || number <= 0 || number > 1000000) return null;
    const rounded = Math.round(number * 100) / 100;
    return rounded > 0 ? rounded : null;
  }

  function supportedCurrency(value) {
    if (!/^[A-Z]{3}$/.test(value)) return false;
    try {
      if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
        return Intl.supportedValuesOf('currency').includes(value);
      }
    } catch (_) {
      return FALLBACK_CURRENCIES.has(value);
    }
    return FALLBACK_CURRENCIES.has(value);
  }

  function reviewFlags(value) {
    const source = object(value) ? value : {};
    return {
      pricing: source.pricing === true,
      operator: source.operator === true,
      legal: source.legal === true
    };
  }

  function featureList(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
      return DEFAULT_FEATURES.slice();
    }
    const clean = value.map((item) => text(item, 120)).filter(Boolean);
    return clean.length === value.length ? clean : DEFAULT_FEATURES.slice();
  }

  function validRuntimeOrigin(value) {
    if (typeof value !== 'string' || !value) return false;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const local = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]' || host === '::1';
      const protocolOkay = url.protocol === 'https:' || (url.protocol === 'http:' && local);
      return protocolOkay
        && !url.username && !url.password
        && (!url.pathname || url.pathname === '/')
        && !url.search && !url.hash
        && url.origin.replace(/\/$/, '') === value;
    } catch (_) {
      return false;
    }
  }

  function runtimeReady(runtime) {
    return object(runtime)
      && runtime.mode === 'hosted'
      && runtime.authEnabled === true
      && runtime.complete === true
      && validRuntimeOrigin(runtime.workerUrl)
      && validRuntimeOrigin(runtime.workerConnectOrigin)
      && runtime.workerUrl === runtime.workerConnectOrigin
      && Array.isArray(runtime.errors)
      && runtime.errors.length === 0;
  }

  function resolveRuntime(rootLike, locationLike) {
    const root = rootLike || (typeof globalThis !== 'undefined' ? globalThis : null);
    const api = root && root.KjrForexConfig;
    if (!api || typeof api.resolve !== 'function') {
      return { mode: 'broken', authEnabled: false, complete: false, workerUrl: '', workerConnectOrigin: '', errors: ['configuration module is unavailable'] };
    }
    try {
      return api.resolve(root.__KJR_FOREX_CONFIG__ || {}, locationLike || root.location || {});
    } catch (_) {
      return { mode: 'broken', authEnabled: false, complete: false, workerUrl: '', workerConnectOrigin: '', errors: ['configuration resolution failed'] };
    }
  }

  function normaliseConfig(input, runtime) {
    const source = object(input) ? input : {};
    const flags = reviewFlags(source.reviewFlags);
    const currencyValue = text(source.currency, 16).toUpperCase();
    const currency = supportedCurrency(currencyValue) ? currencyValue : '';
    const monthly = amount(source.proPriceMonthly);
    const annual = amount(source.proPriceAnnual);
    const ready = source.mode === 'READY'
      && flags.pricing && flags.operator && flags.legal
      && !!currency && (monthly !== null || annual !== null)
      && source.checkoutEnabled === true
      && runtimeReady(runtime);
    return Object.freeze({
      mode: ready ? 'READY' : 'PREVIEW',
      pricingApproved: ready,
      reviewFlags: Object.freeze(flags),
      currency: ready ? currency : null,
      proPriceMonthly: ready ? monthly : null,
      proPriceAnnual: ready ? annual : null,
      proFeatures: Object.freeze(featureList(source.proFeatures)),
      signUpHref: safeRelativeHref(source.signUpHref, DEFAULT_SIGNUP),
      signInHref: safeRelativeHref(source.signInHref, DEFAULT_SIGNIN),
      checkoutEnabled: ready
    });
  }

  function formatPrice(config, value, period) {
    if (!config || !config.pricingApproved || value === null) return 'To be announced';
    try {
      const rendered = new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: config.currency,
        currencyDisplay: 'code',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(value);
      return period ? rendered + ' / ' + period : rendered;
    } catch (_) {
      return 'To be announced';
    }
  }

  function setText(root, selector, value) {
    const node = root.querySelector(selector);
    if (node) node.textContent = value;
    return node;
  }

  function setHref(root, selector, href) {
    const node = root.querySelector(selector);
    if (node) node.setAttribute('href', href);
    return node;
  }

  function setHidden(root, selector, hidden) {
    const node = root.querySelector(selector);
    if (!node) return null;
    node.hidden = hidden;
    if (hidden) node.setAttribute('hidden', '');
    else if (typeof node.removeAttribute === 'function') node.removeAttribute('hidden');
    else if (node.attributes) delete node.attributes.hidden;
    return node;
  }

  function renderFeatureList(root, config, documentLike) {
    const list = root.querySelector('[data-pro-features]');
    if (!list || !documentLike) return;
    list.replaceChildren();
    config.proFeatures.forEach((feature) => {
      const item = documentLike.createElement('li');
      item.textContent = feature;
      list.appendChild(item);
    });
  }

  function render(documentLike, input, runtime) {
    const config = normaliseConfig(input, runtime);
    const documentRef = documentLike || (typeof document !== 'undefined' ? document : null);
    if (!documentRef) return config;
    const page = documentRef.querySelector('[data-public-pricing]');
    if (!page) return config;
    page.dataset.publicMode = config.mode.toLowerCase();
    setHidden(page, '[data-local-plan]', config.pricingApproved);
    setText(page, '[data-public-status]', config.pricingApproved ? 'Pricing available' : 'Private preview');
    setText(page, '[data-pricing-state]', config.pricingApproved ? 'Published plan details' : 'Pricing: To be announced');
    setText(page, '[data-pricing-copy]', config.pricingApproved
      ? 'Online accounts and paid plans are available through the account entry point.'
      : 'Use the local journal on this device today. Online accounts and paid plans remain unavailable in this preview.');
    setText(page, '[data-preview-copy]', config.pricingApproved
      ? 'The published plan details are shown below. Account access follows the configured account entry point.'
      : 'No account or payment is submitted from this page. Checkout will remain closed until commercial and legal review is complete.');
    setText(page, '[data-plan-list-copy]', config.pricingApproved
      ? 'Free and Pro account plans are shown here. Journal access follows the account entry point.'
      : 'These descriptions separate what is usable locally from what is planned for a hosted release.');
    setText(page, '[data-local-copy]', config.pricingApproved
      ? 'Account mode is enabled. Use the account entry point before opening the journal.'
      : 'Record and review trades in the local preview without an account or payment step.');
    setText(page, '[data-local-access]', config.pricingApproved
      ? 'Account required'
      : 'No account required for this preview');
    setText(page, '[data-local-kicker]', config.pricingApproved ? 'Account required' : 'Available now');
    setText(page, '[data-free-kicker]', config.pricingApproved ? 'Available' : 'Planned');
    setText(page, '[data-free-price]', config.pricingApproved ? 'Free account' : 'When online accounts open');
    setText(page, '[data-free-copy]', config.pricingApproved
      ? 'Create a free account with up to 50 saved trades.'
      : 'Up to 50 saved trades when online accounts become available.');
    setText(page, '[data-pro-kicker]', config.pricingApproved ? 'Available' : 'Planned');
    setText(page, '[data-pro-price-monthly]', formatPrice(config, config.proPriceMonthly, 'month'));
    setText(page, '[data-pro-price-annual]', formatPrice(config, config.proPriceAnnual, 'year'));
    setText(page, '[data-pro-copy]', config.pricingApproved
      ? 'The published Pro plan is available through the account entry point.'
      : 'Pro is planned. Checkout is unavailable in this preview.');
    setText(page, '[data-free-cta]', config.pricingApproved ? 'Create free account' : 'View account options');
    setText(page, '[data-entry-title]', config.pricingApproved ? 'Online accounts' : 'Online accounts are planned');
    setText(page, '[data-entry-copy]', config.pricingApproved
      ? 'Use the account entry point to sign in or create a free account.'
      : 'The local preview opens the account entry point without sending a sign-up request.');
    setText(page, '[data-free-availability]', config.pricingApproved
      ? 'Free account access follows the configured account entry point.'
      : 'Availability to be announced');
    setText(documentRef, '[data-public-footer]', config.pricingApproved
      ? '© Kujira Forex · Published plan details'
      : '© Kujira Forex · Private preview');
    setText(page, '[data-local-cta]', config.pricingApproved ? 'Sign in' : 'Open local journal');
    setHref(page, '[data-signup-link]', config.signUpHref);
    setHref(page, '[data-signin-link]', config.signInHref);
    setHref(page, '[data-local-cta]', config.pricingApproved ? config.signInHref : './index.html');
    // Checkout is closed until the review flags and the hosted runtime are ready. Closed is a real disabled button, so it cannot be
    // focused, pressed or followed. Ready swaps in the account link. The page ships in the closed state, so a failed script fails closed.
    setHidden(page, '[data-checkout-unavailable]', config.pricingApproved);
    setHidden(page, '[data-checkout-link]', !config.pricingApproved);
    setHref(page, '[data-checkout-link]', config.signUpHref);
    renderFeatureList(page, config, documentRef);
    return config;
  }

  return Object.freeze({
    normaliseConfig,
    runtimeReady,
    resolveRuntime,
    safeRelativeHref,
    supportedCurrency,
    validRuntimeOrigin,
    formatPrice,
    render,
    DEFAULT_SIGNUP,
    DEFAULT_SIGNIN
  });
}));

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', function () {
    const source = typeof globalThis !== 'undefined' ? globalThis.KJR_PUBLIC_CONFIG : null;
    if (typeof globalThis !== 'undefined' && globalThis.KjrPublic) {
      globalThis.KjrPublic.render(document, source, globalThis.KjrPublic.resolveRuntime(globalThis, globalThis.location));
    }
  });
}
