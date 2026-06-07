# Security

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities. Instead:

1. Use GitHub's **private vulnerability reporting** on this repository, **or**
2. Email the maintainer privately (see `MAINTAINERS` in the repo root if listed).

Expect a response within 7 days. Coordinated disclosure preferred.

## Architecture in one paragraph

This is a static HTML/JS app distributed via GitHub Pages. It has no backend that the maintainers run. Each user deploys their own Google Apps Script + Google Sheet, which is the only place their data lives. The app talks to *the user's own* Apps Script URL — that URL is the only credential, known only to the user.

## Threat model

| Threat | Severity | Status |
|---|---|---|
| Drive-by attacker hits another user's data | Critical | **Mitigated** — there is no central data store. Each user's data is isolated to their own Google account. |
| Compromised CDN serves malicious Chart.js | High | **Mitigated** — Chart.js is loaded with a Subresource Integrity SHA-384 hash. Browser refuses to execute if the bytes differ. |
| XSS via attacker-controlled values stored in the sheet | High | **Mitigated** — all user input is sanitised on save (`kjrSafeId`, `kjrSafeString`, `kjrSafeNumber`) and on load (`mergeDefaults` re-validates every entry). Edit buttons use event delegation with `data-` attributes instead of inline `onclick` JS-context interpolation. |
| Future XSS bypasses sanitisation and tries to exfiltrate data | Medium | **Mitigated** — strict Content Security Policy: `connect-src` allows only `script.google.com` and `script.googleusercontent.com`. Even a successful XSS cannot POST data to an attacker-controlled domain. |
| Cross-app localStorage leak | Medium | **Mitigated** — the app should be hosted on its own dedicated subdomain (e.g. `kujira-portfolio.github.io`) so its localStorage is isolated from any other app on the same parent domain. |
| Malformed payload corrupts the sheet | Low | **Mitigated** — the Apps Script `doPost` strips unknown top-level keys, caps array length (5000 per table) and string length (5KB per field), and rejects payloads over 49.5 KB. |
| Apps Script URL leaked via screenshot, tutorial, or screen-share | High | **Documented** — the URL field is a password input by default with a reveal-with-confirmation toggle. The URL is also redacted from the diagnostics panel. Ultimately the user must guard it. |
| Lost or stolen device with unlocked browser | Medium | **Documented, not mitigated** — standard web-app risk. Future hardening could add a passphrase-derived encryption layer on localStorage. |
| Compromised Apps Script via malicious paste | High | **User responsibility** — the user must paste only the official `2026-05-24-portfolio-apps-script.txt` from this repo. Verify integrity by checking the SHA of the file against the release notes if security-sensitive. |

## Frontend hardening

- **CSP**: `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' https://script.google.com https://script.googleusercontent.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none';`
- **SRI**: Chart.js pinned to version `4.4.1` with SHA-384 integrity hash.
- **Input sanitisation**:
    - `kjrSafeId(s)` — ids must match `/^[A-Za-z0-9_-]{1,64}$/`
    - `kjrSafeString(s, maxLen)` — strips ASCII control chars (preserving tab/newline/CR), caps at 500 by default, 5000 for textareas
    - `kjrSafeNumber(s, opts)` — coerces to finite float with optional min/max
- **Output escaping**: every place user data hits the DOM uses `kjrEscape()` for HTML context. Edit buttons use `data-edit-table` + `data-edit-id` attributes with a delegated handler that re-validates the id — no user data is ever interpolated into a JS context.
- **URL redaction**: error messages and diagnostics scrub any `script.google.com/macros/s/.../exec` URL fragments.

## Backend (Apps Script) hardening

- **Schema check**: payloads must declare `schema: 'kujira-portfolio'` or are rejected.
- **Top-level key allowlist**: unknown keys are dropped, not stored.
- **Size caps**: payload max 49.5 KB; arrays max 5000 entries; strings max 5 KB.
- **Optimistic concurrency**: `lastSeenRemoteAt` token detects concurrent writes from another tab/device and returns `{ conflict: true }` instead of overwriting.
- **Per-table view sheets**: `Stocks`, `Crypto`, `Real Estate`, `Cash`, `CPF Balances`, `CPF History`, `Income`, `Expenses`, `Trash`, `Settings` — each written atomically (single `setValues` call) so a partial timeout cannot leave a tab half-written.

## Audit checklist (run before each release)

- [ ] `grep -nE 'onclick="[^"]*\${' index.html` returns zero matches.
- [ ] Every `innerHTML` interpolation uses `kjrEscape` (or a known-safe formatter).
- [ ] Chart.js `<script>` tag has `integrity=` and `crossorigin="anonymous"`.
- [ ] CSP meta tag present, validated against the live URL.
- [ ] Setup wizard renders correctly on first launch.
- [ ] No Apps Script URL hardcoded in `index.html` (`grep -i 'AKfycb' index.html` returns no matches).
- [ ] Apps Script's `doPost` rejects: empty body, oversize body, malformed JSON, wrong schema, unknown keys (dropped silently).
- [ ] All view sheets populate when seeded.
- [ ] Lighthouse audit: no console errors, no mixed-content warnings, HTTPS only.
- [ ] End-to-end test in a fresh browser profile.
- [ ] PRIVACY.md and SECURITY.md exist and are linked from the app.

## What we don't promise

This is open-source software offered as-is. No warranty. No guaranteed uptime. No guaranteed security. We do our best with the threat model above; you should review the code yourself before deploying. If you find a problem, please report it privately.
