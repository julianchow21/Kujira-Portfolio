# Chart Builder, multi-source dashboard, implementation spec (v1, 22 Jun 2026)

Hand this to the implementer. The goal is to make every dashboard data
visualisation (Net worth over time, Allocation, Cashflow) buildable and
editable through the Chart Builder, instead of being three hardcoded charts.
Julian has approved the most thorough option: **replace the built-ins with
builder-driven charts** so everything on the dashboard is add/edit/remove/reorder.

All work is in one repo: `~/Claude Projects/Kujira/Portfolio/Portfolio/`.
Main files: `index.html` (the SPA) and `Worker/kjr-core.js` (pure logic, loaded
via `<script src="Worker/kjr-core.js?v=...">`). There is no build step.

## How to read this doc

Line numbers drift as you edit. Every anchor below is given as a **function or
string to grep for**, not just a line. Confirm each location with grep before
editing. Work phase by phase, verify in the browser after each phase, commit
per phase. Do not do it all in one commit.

---

## Hard rules (from CLAUDE.md and project lessons, non-negotiable)

1. **No silent data loss.** Saved chart configs are user data in localStorage
   (`kjr_portfolio_saved_charts`). Validate on load, never throw on a corrupt
   entry, drop only what is genuinely invalid. Soft-delete with undo already
   exists, keep it.
2. **British English. No em-dashes** (use commas, brackets, full stops). No AI
   filler words. Match the existing terse comment style.
3. **Theme-safe colours.** Never hardcode chart colours. Read them at draw time
   via `_cssVar('--text3')`, `_cssVar('--border')`, `_cssVar('--text2')`,
   `_cssVar('--bg2')`, and the `PB_PALETTE` array. The app has light and dark
   themes and charts must honour both. (This is why the original port replaced
   Collectibles' hardcoded axis colours.)
4. **Escape everything user-supplied** with `kjrEscape(...)` before putting it
   in innerHTML (chart titles, symbols, labels). There was already one XSS fix
   in the time-series "no data" note, do not regress it.
5. **HTML5 drag-and-drop is dead on touch.** Every drag affordance must keep its
   tap fallback. The palette pills already have BOTH `ondragstart` and
   `onclick="pbAssignField(...)"`. Preserve the tap path for any new control.
6. **Single source of truth for derived numbers.** Allocation/cashflow/net-worth
   values must come from the SAME helpers the rest of the app uses
   (`_netWorthClassesSGD`, `expenseAmountSgd`, `DB.snapshots`), never recomputed
   a second way, or the dashboard will disagree with itself.
7. **Verify in-browser before shipping.** Use the preview server named
   `investments` (serves the Portfolio parent dir; open `/Portfolio/index.html`).
   Note the preview can report a 0px viewport, so assert via computed styles and
   DOM measurement, not only screenshots.
8. **Bump the version badge and use `/ship`.** `APP_VERSION` and
   `APP_DISPLAY_VERSION` near the top of the `<script>` (grep `APP_VERSION =`).
   Bump the `?v=` on the kjr-core script tag only if you change that file.

---

## Naming and emoji removal (do this in Phase 1, it is small)

- **Rename "Custom Chart Builder" to "Chart Builder".** Grep `Custom Chart
  Builder` (the `<h3>` inside `_pbEnsureUI`, and the HTML comment above
  `<div id="stocks-builder">`). Update both. The decorative icon in that `<h3>`
  is an inline SVG bar-chart, keep it (it is not an emoji).
- **Remove the field emojis.** The field schema currently carries an `icon:`
  emoji per field (🔖 🏛️ 💱 🏷️ 📈 💵 💹 📊 🔢 💰 🪙 ⚖️ #️⃣). Stop rendering them:
  - In `pbInitPalette`, delete the `<span class="pill-icon">${f.icon}</span>`.
  - In `pbRenderChips`, remove the `${f.icon} ` prefix (keep the label + remove
    button).
  - You may delete the `icon:` keys from the schema entirely once unused.
- **De-emoji the builder chrome.** Replace emoji-only buttons with text or the
  existing SVG idiom:
  - Saved-card pin button 📌/📍 (grep `pbTogglePin`): use text "Pinned" / "Pin".
  - Empty-state icons `📊` inside the builder (grep `empty-icon">📊`): remove the
    icon line, or swap for the header's small SVG. Keep empty-state TITLE/SUB.
  - The `⚠️` fallback in `pbRenderChips` for an unknown field can become a plain
    `(?)`.
- Leave non-builder emojis elsewhere in the app alone. Scope is the builder only.

---

## Current architecture (what exists today)

**The builder already lives on the Dashboard**, not the Stocks tab (the host id
`stocks-builder` is legacy naming). In `#page-dashboard` you will find, in order:
`#dash-networth`, the `.dash-grid` with the **Net worth over time** and
**Allocation** cards, the **Cashflow** card, `#dash-cpf`, then
`<div id="stocks-builder">` (the builder) and `<div id="saved-charts-container">`
(the saved charts). Saved charts therefore already render on the dashboard, and
the save toast already says "Chart added to dashboard".

**One data source only: stock holdings.**
- `buildStockChartRows()` builds `_stockChartRows` (the same rows the Holdings
  table uses). Row shape includes: `s` (the stock object with `.symbol`,
  `.market`, `.sector`), `ccy`, `mv`, `cost`, `pl`, `plPct`, `shares`,
  `divAnnualSgd`, `divYieldCur`, `weight`, `ysym`, `avgCost`, `priceCcy`.
- `PB_FIELDS` (grep `const PB_FIELDS`) is the single field schema: dims
  `symbol/market/currency/sector`, measures `marketValue/costBasis/unrealPnl/
  pnlPct/shares/divIncome/divYield/weightPct/posCount`. Each field is
  `{ label, icon, type:'dim'|'meas', agg?:'sum'|'avg', unit?:'money'|'pct'|'count', get:(row)=>value }`.

**Two render modes, dispatched in `_pbDrawInto` on `cfg.mode`:**
- `crosssec` -> `_pbDrawCrossSectional(host,cfg,...)`: calls
  `kjrChartAggregate(rows, cfg.xFields, cfg.yFields, PB_FIELDS, cfg.sort, cfg.topN)`
  then builds a bar/line/doughnut/scatter Chart.js chart.
- `timeseries` -> `_pbDrawTimeSeries(host,cfg,...)`: **hard-wired to stock
  symbols + Yahoo** via `fetchStockHistory(ysyms, range)` and `_pbHistCache`,
  with optional dashed avg-cost lines and 1M/3M/6M/1Y ranges.

**The aggregator is already generic** (`kjrChartAggregate` in `Worker/kjr-core.js`,
grep `function kjrChartAggregate`): signature
`(items, xFields, yFields, fields, sort, topN)`. It takes the field dict as an
argument, so it does NOT need changing, it just needs to be handed the right
per-source dict. Same for `kjrFmtMeasure(val, field, curSym)` and
`kjrFmtAxis(val, field, curSym)`.

**Persistence + state:**
- Live builder state: `pbState` (localStorage `kjr_pb_cb_state_v1`), loaded by
  `_pbLoadState`, saved by `_pbSaveState`.
- Saved charts: `pbLoadSaved()` / `pbPersistSaved()` (localStorage
  `kjr_portfolio_saved_charts`). `pbLoadSaved` is the validator, it currently
  filters `xFields`/`yFields` against the global `PB_FIELDS`.
- `pinned` currently means "protected from delete", not "show on dashboard".

**The three built-in charts (to be replaced):**
- `drawNetWorthChart()`: line over `DB.snapshots` `[{date, net, byClass}]`.
  `byClass = {stocks,cash,cpf,realestate,crypto}` is stored (per-class history
  exists going forward).
- `drawAllocationChart(classes, net)`: doughnut over the `classes` array built
  in `renderDashboard` (`[{key:'Stocks',val,color:'--accent'},...]`, plus Crypto
  if > 0). Respects the CPF on/off hero toggle via `displayClasses`.
- `drawCashflowChart()`: grouped bar (Income vs Expenses) over the last 6 months
  from `DB.income` (`Number(i.net)||Number(i.gross)`, date `i.date`) and
  `DB.expenses` (`expenseAmountSgd(x)`, date `x.date`), bucketed by `YYYY-MM`.
- All three are called at the bottom of `renderDashboard` (grep
  `drawNetWorthChart();`).

---

## Target architecture: PB_SOURCES registry

Replace the single `PB_FIELDS` with a registry of sources. Each source declares
its kind, its fields, and how to produce rows or a series.

```js
// kind: 'crosssec'  -> aggregated via kjrChartAggregate (bar/line/doughnut/scatter)
//       'series'    -> internal time series (line/area) drawn from {labels, datasets}
//       'holdings'  -> special: cross-sectional PLUS the Yahoo price-history mode
const PB_SOURCES = {
  holdings:   { key:'holdings',   label:'Holdings',        kind:'holdings',
                fields: PB_HOLDINGS_FIELDS, rows: () => _stockChartRows },
  allocation: { key:'allocation', label:'Allocation',      kind:'crosssec',
                fields: PB_ALLOC_FIELDS,    rows: () => _pbAllocRows() },
  cashflow:   { key:'cashflow',   label:'Cashflow',        kind:'crosssec',
                fields: PB_CASHFLOW_FIELDS, rows: () => _pbCashflowRows() },
  networth:   { key:'networth',   label:'Net worth',       kind:'series',
                series: (cfg) => _pbNetWorthSeries(cfg) },
};
function pbSource(cfg){ return PB_SOURCES[cfg && cfg.source] || PB_SOURCES.holdings; }
function pbFields(cfg){ return pbSource(cfg).fields || {}; }
```

Every saved config and the live config gains a `source` string (default
`'holdings'` for back-compat). Everywhere the code currently writes
`PB_FIELDS[k]`, change it to `pbFields(cfg)[k]` (or the active source's fields).

**Grep list of every `PB_FIELDS` reference to convert** (confirm each):
`_pbLoadState` filters; `pbInitPalette` groups; `pbDrop`/`pbAssignField`/
`pbRenderChips`; `_pbDrawCrossSectional` (aggregate call, dataset loop, scales,
tooltip, summary); `pbLoadSaved` validation; `pbSaveChart` default title;
`_pbRenderOneSaved` meta. Each must use the source-specific dict, not the global.

---

## Per-source field schemas (exact getters)

### holdings (rename `PB_FIELDS` -> `PB_HOLDINGS_FIELDS`, content unchanged except icons removed)
Keep current dims/measures and getters as-is.

### allocation (`PB_ALLOC_FIELDS`)
Rows: one per asset class with a positive value. Build from the SAME helper the
dashboard uses so numbers match exactly:
```js
function _pbAllocRows(){
  const c = _netWorthClassesSGD();        // {stocks,cash,cpf,realestate,crypto} in SGD
  const net = c.stocks + c.cash + c.cpf + c.realestate + c.crypto;
  const defs = [
    ['Stocks', c.stocks], ['Cash', c.cash], ['CPF', c.cpf],
    ['Real Estate', c.realestate], ['Crypto', c.crypto]
  ];
  return defs.filter(([,v]) => v > 0).map(([cls, v]) => ({ cls, val:v, weight: net>0 ? v/net : 0 }));
}
```
Fields:
- `assetClass`: `{ label:'Asset Class', type:'dim', get:r=>r.cls }`
- `value`:      `{ label:'Value', type:'meas', agg:'sum', unit:'money', get:r=>r.val }`
- `weightPct`:  `{ label:'Weight', type:'meas', agg:'sum', unit:'pct',  get:r=>r.weight*100 }`

Seed default (Phase 4): source `allocation`, x=`assetClass`, y=`value`,
chartType `doughnut`. That reproduces today's Allocation donut.

**CPF toggle rule (confirmed by Julian, applies dashboard-wide):** when the hero
CPF toggle (`_dashShowCpf`) is OFF, CPF must be hidden from EVERYTHING on the
dashboard, not shown anywhere. The live app already enforces this as of v2.18:
hero figure, asset KPI cards, allocation donut, net-worth-over-time line, and
the CPF breakdown card all drop CPF when off. The rebuilt charts must keep this:
the dashboard layer passes the current `_dashShowCpf` into the allocation rows
and the net-worth series builders so CPF is excluded when off (filter the CPF
row out of `_pbAllocRows`; for net worth subtract `byClass.cpf` per point). Do
this as a dashboard-layer parameter, not by reaching into hero state from inside
the generic source. The ONE intentional exception is the **Target allocation**
planner (`renderTargetAllocation`), which stays full-picture because its targets
must sum to 100% including CPF, confirm with Julian before changing that one.

### cashflow (`PB_CASHFLOW_FIELDS`)
Rows: one PRE-AGGREGATED row per recent month (cleanest for the grouped bar and
keeps chronological order via an alpha sort on the `YYYY-MM` key).
```js
function _pbCashflowRows(months){
  const ms = _recentMonths(months || 12);
  const incBy = {}, expBy = {};
  (DB.income   || []).forEach(i => { const ym=String(i.date||'').slice(0,7); if(ym) incBy[ym]=(incBy[ym]||0)+(Number(i.net)||Number(i.gross)||0); });
  (DB.expenses || []).forEach(x => { const ym=String(x.date||'').slice(0,7); if(ym) expBy[ym]=(expBy[ym]||0)+expenseAmountSgd(x); });
  return ms.map(m => { const inc=incBy[m]||0, exp=expBy[m]||0; return { month:m, income:inc, expense:exp, net:inc-exp }; });
}
```
Fields:
- `month`:   `{ label:'Month', type:'dim', get:r=>r.month }`  // 'YYYY-MM', sortable
- `income`:  `{ label:'Income', type:'meas', agg:'sum', unit:'money', get:r=>r.income }`
- `expense`: `{ label:'Expenses', type:'meas', agg:'sum', unit:'money', get:r=>r.expense }`
- `net`:     `{ label:'Net', type:'meas', agg:'sum', unit:'money', get:r=>r.net }`

Seed default (Phase 4): source `cashflow`, x=`month`, y=`income`+`expense`,
chartType `bar`, **sort `alpha`** (so months run chronologically, NOT by value).

**Gotcha:** `kjrChartAggregate` default sort is value-desc, which would scramble
months. Time-bucketed sources MUST use `sort:'alpha'` and a sortable `YYYY-MM`
group key. If you want friendly axis labels ("Jun 2026"), do it in the chart
label callback, not in the group key.

### networth (`series` kind, no field dict)
Not aggregated. Provide a series builder reading snapshots:
```js
function _pbNetWorthSeries(cfg){
  const snaps = (DB.snapshots||[]).slice().sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const cutoff = _pbRangeCutoff(cfg.range);            // null = all; else 'YYYY-MM-DD'
  const rows = cutoff ? snaps.filter(s => s.date >= cutoff) : snaps;
  const labels = rows.map(s => s.date);
  if (cfg.nwMode === 'byClass'){
    const keys = [['stocks','Stocks'],['cash','Cash'],['cpf','CPF'],['realestate','Real Estate'],['crypto','Crypto']];
    return { labels, datasets: keys.map(([k,lab],i)=>({ label:lab, stack:'nw',
      data: rows.map(s => toDisplay((s.byClass&&s.byClass[k])||0,'SGD')), ... })) , stacked:true };
  }
  return { labels, datasets: [{ label:'Net worth', data: rows.map(s=>toDisplay(s.net,'SGD')), ... }] };
}
```
Default seed (Phase 4): source `networth`, `nwMode:'total'`, range `ONE_YEAR`,
line. This reproduces today's Net worth over time line. `byClass` (stacked area)
is the bonus mode, expose it as a toggle in the networth controls.

---

## Phase 1, multi-source foundation

1. Introduce `PB_SOURCES`, `pbSource`, `pbFields`. Rename `PB_FIELDS` to
   `PB_HOLDINGS_FIELDS`, strip the `icon:` keys, keep getters.
2. Add `source` to `pbState` (default `'holdings'`), to `_pbLiveConfig()`, and to
   the saved-config shape in `pbLoadSaved` (validate against `PB_SOURCES`, drop
   unknown sources). Add it to `_pbLoadState` with a safe default.
3. Add a **Source `<select>`** to the builder head in `_pbEnsureUI` (before the
   mode buttons): options from `PB_SOURCES` labels, `onchange="pbSetSource(this.value)"`.
   `pbSetSource` sets `pbState.source`, resets x/y/mode appropriately for the new
   source's kind, saves state, and re-runs `renderStockChartBuilder()`.
4. **Per-source UI adaptation** in `_pbApplyModeUI` (or a new `_pbApplySourceUI`):
   - `holdings`: show the existing two-mode toggle (By holding / Price history),
     palette, cross-sec controls, and the timeseries rail. (Unchanged behaviour.)
   - `allocation`, `cashflow` (`kind:'crosssec'`): hide the mode toggle and the
     timeseries rail; show palette + cross-sectional controls only.
   - `networth` (`kind:'series'`): hide palette and cross-sec controls; show a
     small control set (range buttons reusing `PB_PERIODS`, plus a Total / By
     class toggle). No Yahoo, no symbols.
5. Convert every `PB_FIELDS[...]` reference to `pbFields(cfg)[...]` (grep list
   above). The palette, chips, drop validation, aggregate call, draw, summary,
   save title, and saved-card meta must all read the active source's fields.
6. Rename the visible title to "Chart Builder" and do the emoji removal here.

Verify: holdings charts still build and save exactly as before (this phase must
be behaviour-preserving for holdings). Switch the Source select and confirm the
UI panes swap correctly even before the new draws exist.

Commit: "Chart Builder: multi-source foundation + rename + de-emoji".

## Phase 2, allocation and cashflow sources (cross-sectional)

1. Add `PB_ALLOC_FIELDS`, `_pbAllocRows`, `PB_CASHFLOW_FIELDS`, `_pbCashflowRows`.
2. Generalise `_pbDrawCrossSectional` to pull rows from `pbSource(cfg).rows()`
   (not the holdings-only `_pbFilteredRows`) and fields from `pbFields(cfg)`.
   Keep the keyword filter working for holdings; for allocation/cashflow the
   filter can be a simple label `includes` over the dim value (or hide the
   Filter box for those sources).
3. The dispatch in `_pbDrawInto`: route `kind:'crosssec'` (and holdings
   cross-sec) to `_pbDrawCrossSectional`. Holdings price-history still routes to
   `_pbDrawTimeSeries`.
4. Empty states per source ("No income or expenses yet", "No assets yet").

Verify against the live built-ins: build allocation doughnut, confirm each
slice value equals the existing Allocation card. Build cashflow bar, confirm the
monthly Income/Expenses match `drawCashflowChart`. Confirm month order is
chronological (sort alpha).

Commit: "Chart Builder: allocation + cashflow sources".

## Phase 3, internal time-series source (net worth)

1. Add `_pbNetWorthSeries(cfg)` and `_pbRangeCutoff(range)` (map 1M/3M/6M/1Y to a
   date cutoff; "all" returns null).
2. Add `_pbDrawInternalSeries(host, cfg, showEmpty, showChart)`: takes
   `pbSource(cfg).series(cfg)` `{labels, datasets, stacked?}`, mounts a Chart.js
   `line` chart with theme colours, `pointRadius:0` for long ranges (mirror
   `drawNetWorthChart` and the existing time-series draw), `spanGaps:true`, and a
   tooltip using `fmt(...)`. Stacked area when `nwMode==='byClass'`
   (`fill:true`, `stack:'nw'`, palette per class).
3. Dispatch `kind:'series'` to this new function in `_pbDrawInto`.
4. Net-worth controls: range buttons + Total/By class toggle, persisted in
   `pbState` (`range`, `nwMode`) and in the saved config.
5. Edge: fewer than 2 snapshots -> reuse the existing "need 2+ days of history"
   empty state.

Verify: build the net-worth line, confirm it matches `drawNetWorthChart` for the
same range. Toggle By class, confirm the stack totals equal the total line.

Commit: "Chart Builder: internal net-worth time series".

## Phase 4, replace the built-ins

1. **Seed three default saved charts** if the user has none of them yet (idempotent,
   keyed by a stable `id` like `def_networth`, `def_alloc`, `def_cashflow`). Add a
   `pbSeedDefaults()` run once on boot AFTER `pbLoadSaved`, that inserts any
   missing default config. Mark them `pinned:true` and add an `order` field.
   - `def_networth`: source networth, total, 1Y, line.
   - `def_alloc`: source allocation, x assetClass, y value, doughnut.
   - `def_cashflow`: source cashflow, x month, y income+expense, bar, sort alpha.
2. **Redefine `pinned` as "show on dashboard"** is not needed because all saved
   charts already render on the dashboard. Instead: keep `pinned` = delete-protect
   for the three defaults, and add **ordering + remove/hide**. Add an `order`
   integer to configs; sort `pbLoadSaved` output by `order` then insertion.
   Provide up/down (or a drag handle WITH a tap fallback) in `_pbRenderOneSaved`.
3. **Remove the hardcoded chart cards** from `#page-dashboard`: delete the
   `.dash-grid` (Net worth + Allocation) and the Cashflow card markup, and delete
   the three calls at the bottom of `renderDashboard` (`drawNetWorthChart()`,
   `drawAllocationChart(...)`, `drawCashflowChart()`). You may keep the functions
   for one release as dead code, or delete them and the now-unused
   `dash-nw-chart`/`dash-alloc-chart`/`dash-cf-chart` canvases, `_nwChart`,
   `_allocChart`, `_cfChart`. Cleaner to delete, but grep for every reference
   first (e.g. theme-redraw paths that call `renderDashboard`).
4. The saved-charts container becomes the home of all dashboard charts. Make sure
   `renderStockChartBuilder` (rename to `renderChartBuilder`) still runs on the
   dashboard render path and that `pbRenderAllSaved` paints the ordered list.
5. **Migration safety:** existing users have an empty or partial
   `kjr_portfolio_saved_charts`. `pbSeedDefaults` must add the three without
   duplicating on subsequent boots, and must not wipe the user's own saved
   charts. Never throw if localStorage is malformed.

Verify: fresh load shows the three default charts (matching the old built-ins),
plus any user charts, all editable/removable/reorderable. Delete a default,
confirm it is protected or re-seedable as decided. Reload, confirm order and
contents persist. Corrupt the localStorage value by hand, confirm the dashboard
still loads.

Commit: "Dashboard: built-in charts become default Chart Builder charts".

## Phase 5, verify and ship

- Cross-check each rebuilt chart against the pre-change screenshots/numbers.
- Light AND dark theme: confirm axis/grid/legend colours via computed styles
  after a cache-bust.
- Mobile width (<=768px): the builder grid is `220px 1fr`, confirm it still
  works or stacks; saved cards must be usable.
- Persistence: reload restores builder state and saved charts identically.
- Empty states: no holdings, no snapshots (<2), no income/expenses, filter
  matches nothing, each shows a designed empty state, never a blank canvas.
- Bump `APP_VERSION` + `APP_DISPLAY_VERSION`. Run `/ship` (hard-reload verify,
  commit, push, report live URL). Backend redeploy is NOT needed, this is all
  client-side (no new Apps Script routes).

---

## Gotchas and invariants (read before coding)

- **Do not break holdings.** Phase 1 must be behaviour-preserving for the
  existing holdings charts and any already-saved holdings configs. Old saved
  configs have no `source`, default them to `'holdings'` in the validator.
- **Aggregator sort.** Value-desc reorders categorical X. Time series (cashflow
  months) must use `sort:'alpha'` on a `YYYY-MM` key.
- **Money conversion.** Money measures are stored in SGD and converted at draw
  time with `toDisplay(value,'SGD')` (see `_pbVal`). Do the same for allocation
  and net-worth values. Percentages are already in percent, do not re-scale.
- **CPF toggle coupling.** Keep the allocation source independent of
  `_dashShowCpf`. Do not reach into dashboard hero state from a source.
- **Chart instance lifecycle.** Live and saved charts are tracked in `_pbCharts`
  keyed by canvas id, and destroyed before re-mount (`_pbMountChart`). Reuse that
  helper for the new draws so you do not leak Chart.js instances or get
  "canvas in use" errors.
- **Theme redraw path.** Something re-renders the dashboard on theme change (grep
  `_currentTab === 'dashboard'`). The new draws read `_cssVar` at draw time, so a
  re-render picks up new theme colours, keep that property.
- **kjrEscape** every title/symbol/label going into innerHTML.
- **No backups.** Do not create `Backups/` folders or copies, Julian deletes
  those (project rule).

## Out of scope (do not build unless asked)

- New backend/Apps Script routes. Everything here is client-side.
- Per-class net-worth history beyond what `byClass` already stores. Do not
  backfill history.
- Cross-source charts (e.g. mixing holdings and cashflow in one chart).
- Category-level cashflow drilldown (per-entry rows). Monthly buckets only for v1.

## Suggested commit/verify cadence

One commit per phase, browser-verify after each, do not batch all five. If
anything in Phase 4 (removing the built-ins) feels risky on the day, ship
Phases 1 to 3 first (sources buildable, built-ins still present) and do the
replacement as a follow-up, it is a clean seam.
