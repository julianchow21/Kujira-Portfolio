# Forex QA Report v0.14

Status: **LOCAL CANDIDATE VERIFIED**

Review date: 04/10/2026

Scope: local synthetic QA for the Forex preview, schema, authentication seams, billing seams, and public preview pages

Local verification is complete. Hosted launch remains pending, and M5 to M10 are not marked complete as live milestones.

**Cost constraint, 04/10/2026:** Forex work is zero-cost only. No subscriptions, upgrades, add-ons, paid organisation or other recurring project spend is authorised. The earlier Pro organisation request is explicitly ruled out, not pending.

## Verified local evidence

- Genuine PostgreSQL 18.6 isolated harness passed after the pause and resume billing event update
- The database run used a disposable local cluster and Unix socket, with no live database
- Browser checks ran in the Codex in-app browser against fresh localhost port 48379 using synthetic data only
- Blank trade form validation displayed correctly
- Save and reload retained `DEMO-EURUSD`, long, quantity `1000`, entry `1.10`, exit `1.11`, fees `1`, with expected `+$9` and `.90R`
- Importing the 75-row synthetic CSV beside one existing trade produced 76 trades, 51 closed and 25 open
- The table used four pages, Next worked, and the long synthetic symbol stayed contained in the horizontal table
- Width checks at 320, 375, 768, and 1280 pixels showed no page overflow after the subnav wrap fix, with the 320 pixel computed wrap confirmed
- Dark and light themes worked
- A no-matches filter state worked
- The Account modal fit within 288 pixels at the 320 pixel viewport, and Escape closed it
- The public welcome page opened in dark, light, tablet, and mobile views, with legal links opening the pages labelled as draft previews
- The repaired auth fixture booted v0.14 with a synthetic SDK using memory-only state, with no live Auth claim
- Free account state showed `0/50`, and Pro account state showed `0/unlimited`
- `SYN-B-ONLY` saved under account B, switching to account A showed zero rows, and returning to B showed one row
- An account change closed the open modal
- Signing out hid the trade row
- Register showed the pending-confirmation state
- A simulated sign-in failure was visible, clearing the failure and signing in recovered the account
- Account focus moved to Close account, Shift+Tab wrapped to Settings, Tab wrapped to Close, Escape closed the modal, and the restored `#account-btn` received focus
- From a fresh welcome page, View account options opened `index.html?v=0.14#account`, showed the v0.14 Account dialog, and focused Close account
- The final auth fixture saved `SYN-B-FINAL` under account B, showed zero rows under account A, and showed the B row after returning to B
- The final auth fixture had no console warnings or errors before or after the save
- Test tabs were closed and the viewport was reset, with the welcome deliverable retained

### Latest cache-busted browser receipt

- A fresh localhost cache-busted Auth fixture loaded v0.14 with the synthetic SDK and memory-only storage
- Signed-out `#signup` opened the production Create account form, Register showed the email-confirmation notice while remaining signed out, and the Sign in switch opened the correct form
- Pro History and Cancel requests returned controlled 503 responses, showed an inline `role="alert"` error and retained retry buttons, with the Pro plan and account identity unchanged
- The fixture showed billing receipts for the requested action and retained the active synthetic account identity and plan in the parent status
- The long-email account used the valid 64-character local part `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx@example.invalid`
- The long email wrapped with computed `overflow-wrap:anywhere` and `word-break:break-word` in light theme at a 280 pixel inner frame and dark theme at a 320 pixel viewport, with `html.scrollWidth === html.clientWidth === 320`
- These browser checks reported no console warnings or errors
- The final default pricing page loaded `config.js?v=1.0` and `lib/public.js?v=0.14`, stayed in `data-public-mode="preview"`, showed prices as `To be announced`, and kept checkout disabled at 1280 pixels with `document.scrollWidth === 1280`
- View account options opened the actual `index.html#signup` local-device message, left synthetic fixture trades untouched, and produced zero console warnings or errors
- The pricing page remained overflow-free at 320 pixels in both light and dark themes, with `document.scrollWidth === document.clientWidth === 320`
- At 320 pixels, all three pricing cards measured 296 pixels wide with right edge 308, and `.pricing-grid` computed as `display:grid` with one 296 pixel column
- A synthetic READY local card was hidden with two visible cards at both 1280 and 320 pixels, switching back to PREVIEW restored three cards, TBA prices, and disabled checkout, with no console errors
- Dark pricing body background computed as `rgb(15, 15, 15)`

### Hosted test-surface receipt, 04/10/2026

- Supabase console login succeeded, but the `free2` project quota is full with Collectibles and Journal. No Forex database was created and no existing data was touched
- Cloudflare deployed the isolated `kjr-forex-stripe-test` Worker from the existing committed source with `STRIPE_BILLING_ENABLED:false` and `--strict`, with no provider secrets or bindings
- The test Worker is available at `https://kjr-forex-stripe-test.julianchow21.workers.dev`, version `216295fa-d155-40fb-a0aa-de2ecfc92506`
- Live probes returned `GET /account` and `POST /checkout` as `403 origin_denied`, `POST /webhook` as `503 webhook secret not configured`, and `GET /unknown` as `404 not found`
- All probe responses were `no-store` and had no `Access-Control-Allow-Origin` response
- The authenticated `billing_disabled` branch remains unverified because it requires a Supabase session

## Current test receipts

- Current scoped `test-forex.js`: 80 checks passed
- Current scoped `test-auth.js`: 16 checks passed
- Current scoped `test-billing.js`: 37 checks passed, including the M8/M9 portal action cases
- Current scoped `test-account.js`: 11 checks passed, including account-switch and stale-response fences
- Current scoped `test-settings.js`: 9 checks passed
- Current scoped `test-public.js`: 10 checks passed
- Current scoped `test-launch-cli.js`: 4 CLI checks passed
- Current `check-release.js`: passed the six-page runtime asset union, exact query-string matches, cache name, and badge checks
- Final root `npm test` completed with exit 0 across Portfolio, Trading, and Forex, with Forex 80 core checks, 16 Auth, 37 billing, 11 account, 9 settings, 10 public, 4 launch CLI, and release checks passed
- `check:forex:launch` exited 2 as intended, with `LOCAL_SOURCE_STATUS=PASS` and concrete commercial configuration, hosted runtime, and draft legal blockers reported
- Root `git diff --check` passed
- Local commits `bace715` (`Portfolio v2.67 isolate cached navigation documents`) and `f79260c` (`Forex v0.14 prepare authenticated accounts and test billing`) are recorded as local receipts
- Final root `npm test` exited 0 after upstream `ff95ce7d0` and the cache fix, with the final UTF-8-only change verified by seven service-worker checks and the Portfolio release check
- The vendored Supabase SDK is 217945 bytes and byte-identical to the official npm 2.117.2 tarball, with registry SHA512 and SHA1 metadata verified, SHA-256 `59d39487c3589843b410322d8a3d562ce022aba1e5ccb16898ef3fb2a0da2ecd`, and matching SRI
- First-party staged diff checks passed, with the sole upstream vendor line 7 trailing-whitespace difference preserved
- A real Codex IAB check with the owned loopback server stopped kept cached main Dashboard and cached pilot routes separate, while an uncached pilot query showed the correct UTF-8 offline text
- Earlier invalid auth-fixture attempts caused by stale service-worker or shared-storage state and an SDK stub overwrite were superseded by the successful final checks

## Final verification notes

- The cache-busted View account options link loaded v0.14 in the fresh preview check
- The final fixture save check had no blocked-request or poisoned-dirty console warnings
- The latest signup, controlled billing failure, account identity preservation, and long-email wrapping receipts are browser-verified locally

## External gates

- Forex Supabase test project and owner-run migration, with no free2 capacity currently available
- Paid Pro organisation and other paid project infrastructure are explicitly not authorised and are ruled out under the zero-cost constraint
- Stripe test setup, secrets, configured prices, and the Google-auth surface that was auto-review denied outside the original provider approval, pending the user sign-in or explicit approval choice
- Exact deployed Worker origin in the Forex CSP configuration
- Authenticated hosted end-to-end verification, including the `billing_disabled` branch
- Pricing and legal owner review
- Hosted Coach remains disabled

No real trade, customer, payment or hosted Forex database records were read or mutated. The Cloudflare test Worker had no provider secrets or bindings. No new cost or paid service was incurred. No frontend push or deployment was performed. This report records verified local candidate evidence only, with no authenticated billing claim.

*Disposable point-in-time doc. Delete once fully actioned (see AGENTS.md, Folder cleanliness).*
