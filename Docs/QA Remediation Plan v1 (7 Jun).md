# Kujira Portfolio — QA Remediation Plan

Date: 07/06/2026. App at ~v0.9.9. Source: an external 35-point "production-readiness" report, triaged against the real code and the 4 Jun QA report.

## Verdict

The report is grounded in real code but calibrated for a multi-user enterprise SaaS, not a solo single-user tracker. Of 35 points: ~7 are already done, ~8 overstated, 1 fabricated, ~7 enterprise-overkill for a solo tool, leaving ~12 genuinely worth doing (mostly small). Same solo-vs-enterprise call already made for the Collectibles 23-pass audit.

Decisions (Julian, 07/06): solo threat model · full money correctness via a money helper · keep the single-file zero-build deploy, add focused tests.

## Disposition of all 35 points

Legend: FIXED done this round · DONE already in code · OVERSTATED real but smaller than stated · FABRICATED not true here · SOLO out of scope for a single-user tool · ACCEPT intentional · PLAN scheduled below.

### Critical
| # | Item | Disposition |
|---|------|-------------|
| 1 | Destructive DB seeding | **FIXED** — `seedDecision()` refuses to overwrite a populated remote under an unexpected schema (closes the SCHEMA-bump wipe) |
| 2 | Floating-point money math | PLAN P1 — money helper + migrate ~95 sites |
| 3 | XSS via weak CSP | OVERSTATED — 3-boundary sanitisation already exists; residual is `unsafe-inline` only (P3/accept) |
| 4 | Unencrypted at rest | SOLO — localStorage on own device |
| 5 | No auth boundary | OVERSTATED — URL never committed, entered as password, redacted on display; optional shared-secret P2 |
| 6 | DOM attribute escaping | OVERSTATED — `kjrEscape` escapes both quote types; residual is `javascript:` URLs (P3 minor) |
| 7 | Global namespace pollution | SOLO — single-scope app by design; extraction to kjr-core.js trims it slightly |
| 8 | Insecure deserialization / RCE | **FABRICATED** — zero `eval`/`new Function` |

### High
| # | Item | Disposition |
|---|------|-------------|
| 1 | Main-thread blocking (salary engine) | SOLO — negligible at personal data scale |
| 2 | Timezone / date-boundary snapshots | PLAN P2 |
| 3 | Silent 302 failures | OVERSTATED — `safeJson` + failed pill already handle it |
| 4 | Canvas memory leaks (Chart.js) | **DONE** — `.destroy()` on every re-render |
| 5 | Monolithic architecture (Vite) | SOLO — keep single-file; add tests instead |
| 6 | Apps Script quota | SOLO — single user won't approach limits |
| 7 | Schema migration | PLAN P2 — de-risks #Crit-1 further |
| 8 | Race conditions / mutex | OVERSTATED — conflict modal + abort + timestamp compare |
| 9 | Tab sync conflicts | PLAN P2 — `storage` event listener |
| 10 | Request timeout / backoff | PLAN P2 — pull/push have no timeout (conflict path already retries) |
| 11 | Unthrottled auto-refresh | **DONE** — pauses on hidden tab |

### Medium
| # | Item | Disposition |
|---|------|-------------|
| 1 | Offline service worker | PLAN P4 |
| 2 | Hardcoded statutory logic | ACCEPT — intentional, updated per release |
| 3 | Manual data backup | **DONE** — backup/restore feature exists |
| 4 | Untestable architecture | PLAN P0 — pure logic extracted + tested (partial) |
| 5 | Unmanaged CDN deps | SOLO — Chart.js already SRI-pinned |
| 6 | Zero observability (Sentry) | SOLO |
| 7 | Input debouncing | PLAN P3 — debounce helper exists, verify coverage |
| 8 | Browser history API | PLAN P3 — reuse Collectibles `popstate` pattern |
| 9 | NaN / Infinity states | PLAN P1 — guard every ratio |
| 10 | Event-listener leaks | N/A — no resize listener to leak |

### Low
| # | Item | Disposition |
|---|------|-------------|
| 1 | A11y violations | PLAN P3 — aria-live on toasts, labels on toggles |
| 2 | Mobile sticky-header jank | PLAN P3 — reproduce first |
| 3 | Missing semantic HTML | **DONE** — `main`/`nav`/`section` present |
| 4 | CORS preflight optimisation | **DONE** — `text/plain` POST already used |
| 5 | Chart resize / ResizeObserver | PLAN P3 — verify first, Chart.js responsive may suffice |
| 6 | Focus trapping in modals | PLAN P3 |

## Phased plan

- **Phase 0 — safety net.** [x] backup · [x] #Crit-1 seed guard via `kjr-core.js` + `tests/tests.html` (10/10) · [x] extract money/CPF/payday pure logic + golden tests (27/27). `computeStockPosition`, full CPF engine, `kjrSafeNumber`, payday helpers all in `kjr-core.js`; `deriveStockPosition` delegates to it.
- **Phase 1 — money correctness (#Crit-2).** Money helper (fixed-point), migrate ~95 float sites, NaN guards (#Med-9). Gated behind Phase 0 tests.
- **Phase 2 — sync/integrity.** Schema migration (#High-7), fetch timeout + backoff (#High-10), cross-tab sync (#High-9), timezone-safe snapshots (#High-2), optional GAS shared-secret (#Crit-5).
- **Phase 3 — UX/a11y.** History API (#Med-8), focus trap (#Low-6), aria-live (#Low-1), debounce check (#Med-7), sticky/resize verify (#Low-2/5).
- **Phase 4 — offline.** Service worker app-shell cache (#Med-1).

## Verification

Unit: `tests/tests.html` (zero build, open in browser) — currently 10/10. Browser: Claude Preview golden path + edge cases (empty state, seed-guard against a mocked mismatched-schema response, two-tab edit, back button, modal focus trap, offline reload, NaN-free charts). Runbook: relevant sections of `QA Runbook (4 Jun).md` per change. Backup before the money migration.

## New files this round
- `kjr-core.js` — pure, testable core (seed-safety now; money/CPF next).
- `tests/tests.html` — zero-build browser test runner.
