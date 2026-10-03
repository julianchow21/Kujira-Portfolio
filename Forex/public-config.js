/* Public commercial preview configuration.
 *
 * This file contains no credentials, provider identifiers or live prices.
 * A future release may replace the nullable values only after the owner has
 * approved the commercial and legal review flags. The preview stays closed
 * while those flags are false.
 */
(function (root) {
  'use strict';

  root.KJR_PUBLIC_CONFIG = Object.freeze({
    schemaVersion: 1,
    mode: 'PREVIEW',
    reviewFlags: Object.freeze({
      pricing: false,
      operator: false,
      legal: false
    }),
    currency: null,
    proPriceMonthly: null,
    proPriceAnnual: null,
    proFeatures: Object.freeze([
      'Unlimited trades',
      'Advanced review',
      'Simulator',
      'Chart markers',
      'CSV import'
    ]),
    signUpHref: './index.html?v=0.14#signup',
    signInHref: './index.html?v=0.14#account',
    checkoutEnabled: false
  });
}(typeof globalThis !== 'undefined' ? globalThis : this));
