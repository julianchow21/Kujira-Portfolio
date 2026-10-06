You are picking up a UI redesign of the **Portfolio app** in the Kujira Portfolio monorepo. It is Julian's personal net-worth tracker: SGX and US stocks, crypto, cash, CPF, real estate, insurance, income and spending, and FIRE projections, with SGD as the base currency. It is a static single-page PWA with no framework and no build step. The monorepo also holds the Trading and Forex apps. They are out of scope, so leave them alone unless a step below says otherwise.

Julian reviewed the design in a previous Claude Code session on 6 Oct 2026 and approved Steps 1 to 3 as the first release ("right, sure. Lets do that."). Nothing was rejected. Start at Step 1.

## 0. Setup and ground rules

- **Repo and branch.** The repo is https://github.com/julianchow21/Kujira-Portfolio (private). Clone it and work on the `redesign` branch (`git checkout redesign`). That branch is `main` at Portfolio v2.68 (`d4f42fa`) plus this handoff and `Docs/Redesign Mockups/`. No app code has changed yet.
- **Never push to or merge into `main` without Julian's explicit yes.** According to `CLAUDE.md`, `main` is what GitHub Pages serves as the live app. The Pages URL couldn't be confirmed from the Mac, so ask Julian if you need it.
- **Commits and pushes.** Commit to `redesign` at the end of each step, once Julian has seen the screenshots. Push `redesign` only when he says so.
  - `CLAUDE.md` says "Direct to main, no feature branches". The `redesign` branch is a deliberate exception that Julian set up for this handoff (see open question 5).
  - Ignore any earlier pasted prompt that told you to commit to main. This document replaces it.
- **Paths outside the repo.** `CLAUDE.md` and `AGENTS.md` (a symlink to it) are tracked, so they are in your clone. Read the root `CLAUDE.md` and `Portfolio/CLAUDE.md` first. They point to `~/.assistant-control/AGENTS.md` (master rules) and `~/.assistant-control/tasks/todo.md` (feature backlog). Neither exists, even on Julian's Mac, so ignore those pointers. Section 4 summarises the essentials.
- **Gitignored, and not needed:** `.claude/` (but `.claude/launch.json` is tracked anyway), `.wrangler/`, `node_modules/` and `*.xlsx`. Spreadsheets are personal financial data and are excluded on purpose. Never add them.
- **Access you need:**
  - Push access to this repo, for the `redesign` branch only.
  - Node 18 or later (the Mac runs Node 24).
  - A browser for previews, with internet access to `fonts.googleapis.com`, `fonts.gstatic.com` and `cdn.jsdelivr.net` (Chart.js).
- **Access you don't need:** UI work needs no Google account, Apps Script URL, Google Sheet, NAS, Supabase, Tailscale, Cloudflare or Stripe access. Don't ask for any of them.
- **Baseline.** On the Mac, `npm test` (run from `Portfolio/`) was fully green at `d4f42fa`. Run it before any change, and keep it green after every step.
- **Don't touch data logic.** Leave sync, Apps Script, the vault (device encryption), NAS/Supabase, the salary and CPF engines and the money maths alone. This work is presentation only, apart from the two bug fixes in Step 2 and Step 3.
- **Screenshots.** At the end of each step, take before and after screenshots: desktop at 1440 px and mobile at 375 px, in dark and light themes. Show them to Julian before committing.

### Commands

- **Dev server:** from the repo root, `npx serve -l 3807 .`, then open http://localhost:3807/Portfolio/. A 404 at the bare root is expected. The launch config is `kjr-portfolio` in `.claude/launch.json`.
- **Tests:** `cd Portfolio && npm test`. This runs the Node suites, then `tests/check-release.js`. There's an optional browser suite (`npm run test:browser`) and a sortable suite (`Portfolio/tests/tests.html`, opened in a browser).
- **Static checks before a release:**
  - `grep -oE "^function [a-zA-Z0-9_]+" Portfolio/index.html | sort | uniq -d` must print nothing.
  - `grep -i 'AKfycb' Portfolio/index.html` must print nothing.
  - The Chart.js `<script>` must keep its `integrity` and `crossorigin="anonymous"` attributes.
- **Ship and version rule** (every release, in one edit):
  - Bump `APP_VERSION` and `APP_DISPLAY_VERSION` in `Portfolio/Worker/app.js` (lines 14 and 15, currently `'v2.68'` and `'v2.68 (04 Oct)'`).
  - Set `CACHE_NAME` in `Portfolio/sw.js` to `'kjr-portfolio-' + APP_VERSION`.
  - Update every `?v=` on the seven `Worker/*.js` script tags in `Portfolio/index.html` (lines ~1650 to 1656) so they match `CORE_ASSETS` in `sw.js` exactly.
  - CSS is inline in `index.html`, so it needs no `?v=`.
  - `check-release.js` enforces all of this.
  - Commit message: `Portfolio v2.69 <imperative description>`, ending with a `Co-Authored-By:` line for the model you're running as.
  - Use the next free version at merge time. If `main` has shipped since, it won't be v2.69.

### Previewing with data, safely

- The Portfolio app has no login. Writes go to Julian's own Google Apps Script, but only when a sync URL is saved, and a fresh localhost profile has none. The sync flush also bails on `localhost` and `file://`. Never paste a production Apps Script URL into a localhost session, and never activate NAS or device encryption in Settings.
- On first load a setup wizard appears. Click "Skip, I'll do it later".
- **Seeding:** paste the seed script from `Portfolio/Docs/QA SOP.md` (section 3) into the page console. Its numbers are checked against the SOP's invariant table, so keep that table true.
- The SOP seed has no live prices, day changes or net-worth history. To exercise Top movers, day-change colours and the net-worth chart, paste this add-on next. Use it on localhost only, and note that it adds to the SOP seed:

```js
(() => { const now = new Date().toISOString();
DB.stocks.push(
  { id:'stock_seed_nvda', symbol:'NVDA', market:'US', sector:'Information Technology', shares:40, avgCost:95, currency:'USD', divPerShare:0.04 },
  { id:'stock_seed_o39', symbol:'O39', market:'SGX', sector:'Financials', shares:500, avgCost:12.5, currency:'SGD', divPerShare:0.82 });
DB.crypto = [ { id:'crypto_seed_btc', symbol:'BTC', coingeckoId:'bitcoin', amount:0.25, avgCost:60000, currency:'USD' } ];
const q = (s, p, prev, c) => ({ symbol:s, price:p, previousClose:prev, changePct:(p/prev-1)*100, currency:c, fetchedAt:now });
Object.assign(DB._priceCache, { AAPL:q('AAPL',254.3,251.18,'USD'), NVDA:q('NVDA',186.5,190.52,'USD'),
  'D05.SI':q('D05.SI',52.4,52.2,'SGD'), 'O39.SI':q('O39.SI',17.1,17.15,'SGD'),
  bitcoin:{ sgd:152000, usd:112600, change24h:1.8, fetchedAt:now, source:'synthetic' } });
DB.snapshots = Array.from({ length:12 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 12 + i);
  const net = Math.round(600000 * (1 + i * 0.012));
  return { id:'snap_seed_'+i, date:d.toISOString().slice(0,10), net,
    byClass:{ stocks:Math.round(net*0.05), cash:Math.round(net*0.08), cpf:0, realestate:500000, crypto:Math.round(net*0.03), insurance:0 } }; });
saveLocal(); renderAll(); })()
```

- Price-cache keys: US tickers use their plain symbol (`AAPL`), SGX tickers add `.SI` (`D05.SI`), and crypto uses its CoinGecko id (`bitcoin`). Top movers reads `previousClose` for stocks and `change24h` for crypto. The Stocks "Change %" column reads `changePct`. If those fields are missing, Top movers shows only crypto, which looks like a bug but isn't.
- When you finish, run `localStorage.clear(); sessionStorage.clear(); location.reload()`. Never leave seed data behind.

## 1. The design

- **Source (use this first):** `Docs/Redesign Mockups/Dashboard Concept v1 (06 Oct).html`. It's a standalone page, so open it directly in a browser or through the dev server at `/Docs/Redesign%20Mockups/...`.
  - It is a clickable mockup of the redesigned desktop dashboard, a phone view, the reasoning, and the shipping order.
  - Things to try: drag across the chart to scrub, switch range or currency, use Include CPF, use the eye icon, click a holding to open the side panel, and click Refresh prices to see changed rows flash.
  - Its numbers come from a seeded test portfolio. Its surface colours are illustrative. The tokens below are authoritative where they differ.
- **Before screenshots:** `Docs/Redesign Mockups/Before/`, captured at v2.68 with the QA seed.
- **Rendered view:** https://claude.ai/artifact/LTzsRawMN9yfRCq8XCDCRb. It's private to Julian's claude.ai account. If you have the Artifact tool there, you can read it. Otherwise the HTML file above is the same page.

**Direction.** Keep the same data, the Trading navy ground (a v1.9 decision) and Kujira teal. Use fewer boxes, one typeface, and colour that carries meaning. The dashboard should read top to bottom: how much, where it sits, what needs attention, what moved. The target feel is a private-banking statement, not a dashboard template.

### What the audit found (the reasons behind each change)

- **Navigation sprawl.** 11 tabs, the app switcher, the currency toggle, the sync pill and 4 icon buttons share one top bar. At 1440 px, Insurance is cut down to "I", and the overflow into More changes from tab to tab.
- **The dashboard repeats itself.** Allocation appears four times: the asset cards, the stacked bar, the target bars and the doughnut. Then five amber banners restate the target bars. The Chart Builder, a power tool, sits on the dashboard.
- **The hero is weak.** A tiny, disconnected sparkline sits next to a "CPF off" button, which duplicates the "CPF off · Local only" subtitle. The real net-worth chart is far below the fold, with ISO dates on its axis (2025-11-01) and bare numbers (570,000).
- **Three typefaces.** Lexend for headings and nav, the system font for body text, and SF Mono for every table number. The monospace digits make the tables read like a developer console. Headline numbers use weights 700 to 800.
- **Colour has no roles.** Stocks and Crypto are both teal. Gains use Material green `#4CAF50`, which clashes with the teal accent. The wordmark uses a teal-purple-pink gradient. Ambient glow blobs sit behind the page. Coloured left rails appear on KPI boxes, and coloured chips on almost every row (US, SGX, Deposit, Contribution).
- **Noise.** There are emoji empty states (👀 📊 📅 🛡), and builder captions ("X: Asset Class · Y: Value · Top all · doughnut", "4 groups · 4 items · Total…") on pinned charts. Four status pills are scattered around: Local only, Books balanced, CPF off and Prices 31s ago.
- **Unclear currency.** The dashboard shows "$679,740" while Stocks shows "US$41,638".
- **Mobile.**
  - The holdings table scrolls sideways with P&L off-screen.
  - The Stocks toolbar wraps to three rows of buttons.
  - At 375 px, pages with the SGD/USD toggle lay out at 395 px (`.topbar-actions` overflows), so the settings gear is clipped.
- **Bug:** the Crypto card on the dashboard is an empty teal square, in both themes. The cause is in Step 2.

### Tokens

Theme mechanics: bare `:root` holds the **light** tokens, and `html.dark` holds the dark tokens (the default, which `Worker/theme-init.js` applies). Keep every existing variable name (`--bg/bg2/bg3/bg4`, `--text/text2/text3`, `--green`, `--red`, `--accent`, `--glass*` and so on) so nothing breaks. Change values and add the new tokens below.

Dark (`html.dark`):
- Keep the base surfaces and text as they are: `--bg #0B1120`, `--bg2 #111A2E`, `--bg3 #192440`, `--bg4 #223052`, `--text #E8ECF4`, `--text2 #9AA4BA` and `--text3 #7C87A0`. Keep `--text3` as the dimmest colour for small text; it's about 4.9:1 on `--bg2`. The mockup's darker grey is not approved for text.
- Accent stays `--accent #2dd4bf`. Use it only for brand, primary buttons, the active nav item, focus rings and selected controls.
- Gain `#43D193` and loss `#F2707A`, each with a soft background at about 12% alpha (gain `rgba(67,209,147,.12)`, loss `rgba(242,112,122,.12)`). Add them as `--gain`, `--loss`, `--gain-soft` and `--loss-soft`. Point P&L and change colouring at them. Check what else uses `--green` and `--red` before repointing those.
- Asset classes: `--c-stocks #7398FF`, `--c-cash #A9B6CA`, `--c-cpf #AB8DFB`, `--c-re #E2B66D`, `--c-crypto #EF8768` and `--c-insurance #D98BC2`. Soft tints use `color-mix(in srgb, var(--c-x) 16%, transparent)`.
- Attention: keep `--amber #F0C36D`, for things that genuinely need action only.
- Glow: set `--glow1` and `--glow2` to `transparent`, or remove the `body::before` gradients (`index.html` ~line 88).

Light (`:root`):
- Keep the base: `--bg #F6F4EE`, `--bg2 #ffffff`, `--text #1f1d1a`, `--text2 #6b665e`, `--text3 #7b766c` and `--accent #0F6E56`.
- Gain `#13845A`, loss `#C7404B`, soft backgrounds at about 10% alpha.
- Asset classes: `--c-stocks #3F62D4`, `--c-cash #7A889B`, `--c-cpf #7656D3`, `--c-re #B5822E`, `--c-crypto #CF5E3C` and `--c-insurance #A8508E`.
- Check 4.5:1 contrast for any text set in these colours.

### Type, shape, motion

- **One family: Manrope.** Use the Google Fonts URL `css2?family=Manrope:wght@300;400;500;600;700;800&display=swap`, with fallback `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif`.
  - Replace the Lexend `<link>` (`index.html` line 24). Point `--font-display` (~line 65) and the `body` font-family (~line 87) at Manrope.
  - The CSP already allows Google Fonts. `sw.js` doesn't pre-cache fonts, so offline falls back to the system font, which is fine.
- **Numbers.** Apply `font-variant-numeric: tabular-nums` to every number. Remove SF Mono from `.num` (~line 271) and from anywhere else numbers are shown. Keep monospace only for technical text (`.nas-secret`, `.sync-details-technical`, `code`/`pre`, `#diag-output`).
- **Scale:**
  - Display, the headline net worth (`.dash-hero-value`): 48/52, weight 300, -0.035em on desktop, and 36/40 on mobile. Wrap the currency prefix in a span at 0.45em, weight 500, `--text3`, lifted toward the cap height.
  - Page title: 22/28, weight 700, -0.01em.
  - Metric value: 20 to 24/28, weight 600. Nothing uses 800 except the logo.
  - Card title: 14/20, weight 700.
  - Body: 14/22, weight 400 to 500.
  - Small: 13/18.
  - Caption: 12/16, weight 500 to 600.
  - Label: 11/14, weight 700, uppercase, +0.08em, `--text3`. Use labels sparingly (table headers, nav groups).
- **Wordmark:** remove the gradient on the "KUJIRA" logo text and set it in plain `--text`.
- **Shape:** cards use `--radius-lg` 16 px and controls use `--radius` 10 px (optional in Step 2; check that nothing clips). Pills and chips are fully rounded. Cards are a solid `--bg2` with a `--border` hairline. Glass stays reserved for floating elements, as in the v2.39 rule.
- **Motion:** 150 to 200 ms ease-out for hover and press. Side panels use 280 ms `cubic-bezier(.2,.8,.2,1)`. Headline figures roll to new values over 450 ms (cubic ease-out). Changed prices flash a soft gain or loss background that fades over 1.2 s. Respect `prefers-reduced-motion`.
- **Gain and loss** always carry ▲ or ▼ and a sign, never colour alone.

### Components (as in the mockup)

- **Gain/loss pill:** soft background, 12.5 px, weight 700, for example "▲ S$17,812 · 2.7%".
- **Status line:** one quiet `--text3` line under the page title, such as "Tuesday 6 October · prices 31 s ago · books balanced". It replaces the status pills.
- **Include CPF switch:** one small switch next to the "Net worth" label. It replaces the "CPF off" button and the subtitle.
- **Range control:** a segmented 1M, 3M, YTD, 1Y, All, with the selected segment on `--bg3`.
- **Allocation row:**
  - Columns: swatch and name, a track with the actual share filled in the class colour and a 2 px target marker, value, share %, and drift.
  - Drift reads like "+54 pts / target 10%". Drift text is amber only beyond the tolerance setting (5 pts by default), otherwise `--text3`.
  - One split bar sits above the rows.
- **Insight:** a single amber-soft box with one plain sentence and a "Review targets" link. It replaces the five banners.
- **Health tile:** a ring or mini-bars visual plus a value and one line of context. For example, emergency fund "2.3× covered", savings rate "50% of take-home" with 6 monthly bars, and FIRE "25% of FIRE number" with a ring.
- **Monogram:**
  - The CSP blocks external logo images (`img-src 'self' data:`), so generate monograms instead.
  - Shape: a 32 px rounded square with 9 px radius, the class soft tint as background, and the first letter in the class colour, weight 800. Use ₿ for BTC and Ξ for ETH.
- **Holding row:**
  - Asset: monogram, symbol, and "name · market" in `--text3`.
  - Value, with "% of total" underneath.
  - Day %, with "today" underneath.
  - Return %, with the amount underneath.
  - The whole row is a button that opens the side panel.
- **Side panel (holding detail):**
  - 400 px wide, sliding in from the right over a scrim. Esc and the scrim close it.
  - Header: monogram, symbol, name and close button.
  - Content: price with day pill, a 3-month price chart, then a 2-column stats grid (Holding, Average cost, Market value, Unrealised, Dividends a year, Share of net worth), then Trades.
  - Buttons: "Record trade" (primary) and "Edit holding".

### Screens

- **Dashboard (desktop), top to bottom:**
  1. Hero card: "Net worth" with the Include CPF switch, the Display number, a delta pill plus "past month", and the range control on the right. Below it sits a 230 px area chart: faint dashed grid with compact currency labels (S$650k), human date ticks, no point dots, and a pulsing end dot. The line and fill take gain or loss colour from the visible period's result. Scrubbing updates the number, the date and the change.
  2. Two columns (1.55 : 1). "Where it sits" (allocation rows plus the insight) beside "Health" (three tiles).
  3. Two columns. "Holdings" (top holdings by value, a Refresh prices link) beside "Today" (the 4 biggest moves in S$, then "Coming up": payday, CPF contribution, estimated dividends, insurance renewals).
  4. Chart Builder moves to its own Explore page. Pinned charts can still appear on the dashboard below these sections, without builder captions. Keep the existing Arrange widget-ordering system (`data-wid`).
- **Desktop navigation (Step 6):**
  - A 224 px left sidebar on a slightly darker surface.
  - Top: a workspace switcher (whale mark, "Kujira", "Portfolio ▾") holding the Trading and Forex links.
  - Groups: Overview (Dashboard, Projections, Explore), Assets (Stocks, Crypto, Cash, CPF, Real estate, Insurance, with counts), and Money ("Income & spending", which is the `cashflow` tab, plus Watchlist, which is the `board` tab).
  - Footer: Settings, a sync dot and "Synced 2 min ago".
  - Top bar: page title and status line, a "Search or jump to ⌘K" field, the currency switch, Hide amounts and "+ Add".
- **Mobile:**
  - Header: whale, page name, Hide amounts.
  - Hero: Display number at 36 px, delta pill, a full-bleed area chart and range chips.
  - Allocation: split bar and a 2-column legend.
  - Holdings as list rows: monogram, symbol and name, value, and return. There's no sideways table.
  - Filters: one horizontally scrolling chip row. Actions go behind one Add button plus an overflow menu.
  - Bottom bar: Overview, Assets, Money, Plan, More, matching the sidebar groups.
- **Other tabs** (Stocks, Crypto, Cash, CPF, P&L, Real Estate, Insurance, Projections, Settings): in Release 1 they only take on the type, colour and chip cleanup. The structural changes come later, in Steps 6 and 7.

## 2. Plan (one step at a time: show Julian, then continue)

1. **Typography and numbers (start here).**
   - Swap Lexend for Manrope, and set the body and `--font-display` to Manrope.
   - Make all numbers tabular, and remove SF Mono from numbers.
   - Apply the Display style and the dim currency prefix to the hero. Bring metric weights down to 600, and remove the logo gradient.
   - Done when: Manrope loads (`fonts.gstatic.com` appears in the Network panel), the computed font on table numbers is Manrope, and no number uses SF Mono. Both themes look right at 1440 and 375 px, `npm test` is green, the console shows zero errors, and screenshots are taken.
2. **Colour roles and decluttering.**
   - Add `--gain`, `--loss` and the asset-class tokens, then repoint `ASSET_CLASS_COLORS` (`Worker/app.js` ~7883) to them. Read the colour-collision logic right after it (~7895) and keep it working.
   - Make Chart.js colours (read through `_cssVar`) use the new tokens.
   - Remove the glow, the left rails (`.stat-box.g/.y/.r/.b`, ~lines 259 to 262, and `.h-summary-item`) and the emoji empty-state icons. Use line icons from the existing `TABS` icon set instead.
   - Market chips become quiet text, and Deposit and Contribution chips become plain `--text2` text, with the amount's sign and colour carrying the meaning.
   - Fix the Crypto icon. In `renderDashboard` (~app.js 11646), the icon background is `var(${c.color}-soft, var(${c.color}))`. Crypto maps to `--accent2`, and `--accent2-soft` doesn't exist, so it falls back to solid teal and the teal icon disappears. The class tokens and their soft tints fix this.
   - Done when: Stocks and Crypto are clearly distinct on the dashboard and in every chart, the Crypto icon is visible in both themes, no glow, rails or emoji remain, any text in the new colours passes 4.5:1, tests are green, and screenshots are taken.
3. **Status, currency and charts (this completes Release 1).**
   - Add the status line and the single Include CPF switch. Keep the top-bar sync pill until Step 6, because it's interactive.
   - Show S$ or US$ on every displayed amount, with the prefix styled smaller and dimmer. `fmt()` and its siblings (~app.js 990 to 1070, and `fmtSgdOrNative` ~5609) are covered by tests. Update the test expectations on purpose, and leave CSV export formats unchanged.
   - Net-worth chart (~app.js 8000, where `labels = rows.map(s => s.date)` gives raw ISO dates): use human dates ("Nov 2025" for long ranges, "6 Oct" for short ones) and compact currency y-ticks, show no point dots (hover radius 4), use gain or loss colour by period, and add a gradient fill.
   - Move the builder captions and the "weighted-average, not FIFO" footnote into info tooltips.
   - Fix the 375 px overflow, for example by tightening `.topbar-actions` gaps or moving the currency toggle into a menu below 400 px.
   - Done when: every amount shows its currency, a CSV export is byte-identical to one taken before the change, `document.documentElement.scrollWidth === 375` on every tab at 375 px, the QA SOP invariants hold, `npm test` is green, and the version bump to the next free version (v2.69 if `main` hasn't moved) is committed on `redesign`. Julian has seen screenshots of every tab in both themes. Don't merge or push until he says yes.
4. **Dashboard restructure.** Build the hero, "Where it sits", Health, Holdings and Today, as specified above, and add the Explore page for the Chart Builder.
   - Done when: allocation appears exactly once, there are no amber banners, the Chart Builder works fully on Explore including "Add to Dashboard", Arrange still reorders widgets, and the money invariants still hold (dashboard cash equals the Cash tab total, and net worth equals the sum of the classes).
5. **Hero chart ranges and scrubbing.** Build it from `DB.snapshots`, which can be sparse (one per day at most, so degrade gracefully). Use the existing Chart.js 4.4.1 with a crosshair plugin, or a small SVG renderer. Don't add any CDN.
   - Done when: all five ranges work with 0, 1, 2 and 365 or more snapshots, and scrubbing works with mouse and touch.
6. **Sidebar navigation and compact top bar** (ask open questions 3 and 4 first).
   - Done when: nothing truncates at 1024 px or wider, `PHASE_2_TABS` still hides tabs, the cross-app links still work, and the mobile bottom bar matches the groups.
7. **Mobile list rows** for Stocks and Crypto holdings and the Cash and CPF tables below 640 px, plus the chip-row filters. Keep the sortable and Columns system on desktop.
   - Done when: return is visible without scrolling sideways at 375 px.
8. **Polish:**
   - The holding side panel.
   - A ⌘K palette.
   - Refine the existing Hide amounts (`togglePrivacy`, ~app.js 5484): amounts blur at 7 px over 250 ms, and percentages stay readable.
   - The price flash on refresh, number roll, skeleton placeholders while prices load, and Undo on toasts instead of confirm dialogs.
   - Done when: every interaction respects `prefers-reduced-motion` and works by keyboard (Esc closes the panel and palette).

## 3. Open questions for Julian

1. **Lexend (ask at the Step 1 check-in).** On 1 Aug 2026, v2.54 deliberately chose "direction A dark ink and C gallery light, Lexend display". Julian approved this redesign, including the critique of Lexend, on 6 Oct, so proceed with Manrope. Keep the font swap in a self-contained commit so it's easy to revert, and confirm with him once.
2. **Glow.** The ambient glow came from the v1.7 glassmorphism reskin and survived the v2.39 restyle. Removing it is part of the approved Step 2. Mention it in the Step 2 screenshots.
3. **Currency switch (ask before Step 6).** v2.50 settled on "SGD-except-stocks", with per-tab currency. The mockup shows one global SGD/USD switch in the top bar. Release 1 doesn't change this behaviour, only the prefixes. Should it become global?
4. **Shared top bar (ask before Step 6).** `CLAUDE.md` requires Trading, Forex and Portfolio to share one top bar with the three-way `tb-tabs` switcher: change one, change all three. Should the sidebar be Portfolio-only, with the switcher links moved into its workspace menu as real anchors, or should Trading and Forex follow?
5. **Branch rule.** `CLAUDE.md` says "Direct to main, no feature branches". Confirm the `redesign` branch exception, and whether `CLAUDE.md` should say so once this lands. Don't edit `CLAUDE.md` without his yes.
6. **Naming (Step 6).** The mockup renames "P&L" to "Income & spending" and adds an "Explore" page. Confirm both labels.

## 4. Project essentials (from the tracked CLAUDE.md files, non-sensitive parts)

- **Monorepo.** Three static SPAs on GitHub Pages: `Portfolio/`, `Trading/` and `Forex/`. This work touches only `Portfolio/`. Each app has its own `CLAUDE.md`; read `Portfolio/CLAUDE.md`.
- **Portfolio files.**
  - `Portfolio/index.html`: markup, the inline `<style>` (all CSS) and the CSP meta tag.
  - `Worker/app.js`: app logic.
  - `Worker/kjr-core.js`: pure logic, also `require()`d by Node tests. Never add DOM, storage or fetch calls to it.
  - `Worker/kjr-sortable.js`: drag sort.
  - `Worker/kjr-vault.js`: optional device encryption.
  - `Worker/theme-init.js`: blocking theme init.
  - `Worker/apps-script.gs`: the backend. Julian redeploys it by hand after any change, but UI work shouldn't touch it.
  - `sw.js`: the shell cache.
  - Runtime file names never change.
- **Tabs:** Dashboard, Stocks, Watchlist+ (`board`), Crypto, Real Estate, Insurance, Cash, CPF, P&L (`cashflow`), Projections and Settings. `PHASE_2_TABS` (empty today) hides a tab's nav entry while keeping its markup.
- **Themes.** Dark is the default (`html.dark`) and warm light is opt-in (`:root`). Don't copy Trading's or Forex's theme defaults into Portfolio.
- **Glass rule (v2.39).** Glass is only for floating elements: top bar, modals, toasts, the bottom tab bar, the sync pill and toggles. In-flow cards are solid `--bg2` with a hairline and `--shadow-card`. Dense table cells use `--surface-solid`.
- **CSP.**
  - `connect-src` allows only Apps Script.
  - `style-src` and `font-src` allow Google Fonts.
  - `img-src` is `'self' data:`.
  - Any new external host needs a CSP change, which this redesign avoids.
- **Escaping.** Every `innerHTML` interpolation of user or sheet data goes through `kjrEscape`.
- **Data safety.** The preview guard sits at the top of the sync flush and bails on localhost and `file://`. Never clear dirty flags under the guard, and never sync a local preview. Back up before destructive bulk actions. The UI work shouldn't need to touch any of this.
- **Money invariants** (see the QA SOP): dashboard cash equals the Cash tab total (both use `deriveCashBalance()`), net worth equals the sum of the asset-class cards, and stocks market value minus total cost equals unrealised P&L.
- **File naming.** New files get a Title Case name, a version and a short date, for example `Name v1 (06 Oct).ext`. This handoff keeps the cross-project name `Redesign Handoff.md`. Point-in-time docs end with the disposable footer below. Delete superseded versions, and never create `Backups/` folders.
- **Language.** Julian writes British English, so use it in UI copy and docs.

*Disposable point-in-time doc. Delete once fully actioned (see CLAUDE.md).*
