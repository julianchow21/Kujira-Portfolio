# MU Day Trading v3.0 — Default ticker, chart UX overhaul, key levels, industry pill

## Context

Julian day-trades off this dashboard and the current UX fights him: every login lands on MU at 1m even if he trades another ticker, the market pill wording is clunky, the indicator pill row and key-level axis tags clutter the chart, the current-price line blinks harshly and renders dashed, multi-day timeframes (15m/1h/1D) paint with the series clipped at the top and months of bars squashed flat, and there is no fullscreen analysis mode, day separation shading, gauge hover detail, or any industry/style context next to the ticker name.

This plan is written for a Sonnet implementer. Every anchor is given as a function name plus approximate current line. Line numbers WILL drift as you edit, so locate by function/string search, not by absolute line. All verified facts below were read directly from the file, trust them over the project CLAUDE.md (which wrongly says Lightweight Charts v4.2.0 — the CDN tag at line 8 pins **v5.2.0**, and the code uses the v5 API: `chart.addSeries(LC.AreaSeries, …)`, `chart.addPane()`).

**Target file:** `~/Claude Projects/Kujira/Portfolio/MU Day Trading/index.html` (single-file SPA, 1879 lines, no framework, no build step)
**Decisions already confirmed with Julian:** industry pill uses a built-in lookup map + manual edit (NO Yahoo profile fetch, NO Worker change), and key levels get per-level show/hide toggles on the chart.

## Read this before touching anything — global pitfalls

1. **Core vs chart split is sacred.** Header, indicator cards, and alerts are always driven by today's 1m core (`lastCore`, `CORE_PARAMS`). The timeframe selector only changes the chart (`lastChart` via `loadChart()`). Never wire header/cards/alerts to `curTf`.
2. **`SYMBOL` IIFE (~478) runs before `cfg = loadCfg()` (~503) and before `TICKER_RE` (~1668).** Inside the IIFE you cannot reference `cfg` (undefined) or `TICKER_RE` (const TDZ → ReferenceError). Read localStorage directly and inline the regex.
3. **Lightweight Charts `LineStyle` enum: 0=Solid, 1=Dotted, 2=Dashed.** The existing comment at `updateChartLevels` saying `lineStyle:1 // Dashed` is wrong (it is Dotted). The series price line default style is dashed, which is the "dotted line" Julian wants gone.
4. **Fit must run inside double `requestAnimationFrame`** after `setData` (see `refitChart` ~998), otherwise it fits against the previous timeframe's layout. Keep that pattern in the new fit function.
5. **Do not rebind per-node listeners on re-rendered HTML.** The toggles row becomes dynamic in this work, so its handler must move to container-level event delegation.
6. **Alerts/log/cache localStorage keys are namespaced per symbol** (`LS` object ~487, `mu_cfg` itself is global). Do not change that scheme.
7. **Token discipline:** read only the functions named in each step (search by name). Do not re-read the whole file, do not reformat untouched code, do not re-indent. Verify in browser per phase, not per line.

## Step 0 — Setup (do first)

- Copy this plan as a tick-box checklist to `~/Claude Projects/Claude/tasks/todo.md` (Julian's workflow rule), tick items off as you go
- Snapshot backup: copy `index.html` → `Backups/Index Backup (12 Jun) pre-v3 chart UX.html`
- Version badge: footer `<span>` (~469) `v2.9 (12 Jun)` → `v3.0 (12 Jun)`. Commit message must carry the same version

## Feature 1 — Default ticker on load

**Where:** `SYMBOL` IIFE (~478), `renderWatchlist()` (~1669), `removeTicker()` (~1694).

- New cfg field `defaultSymbol` (add `defaultSymbol:""` to `DEFAULT_CFG` ~489)
- `SYMBOL` resolution order: `?symbol=` URL param → `cfg.defaultSymbol` → `"MU"`. Inside the IIFE, after the URL-param check add:
  ```js
  try { var c = JSON.parse(localStorage.getItem("mu_cfg") || "{}");
    if (c.defaultSymbol && /^[A-Z.\-]{1,12}$/.test(c.defaultSymbol)) return c.defaultSymbol; } catch(e){}
  ```
  (Pitfall 2: do not use `cfg` or `TICKER_RE` here.)
- `renderWatchlist()`: every `.wl-item` row (including the current one) gets a star button before the ×/● — `★` filled (colour `var(--amber)`) when `s === cfg.defaultSymbol`, else `☆` in `var(--text3)`, `title="Default on launch"`. Click: set `cfg.defaultSymbol = s` (or `""` if already default → unset), `saveCfg()`, `renderWatchlist()`. **Must `e.stopPropagation()`** — rows carry `data-sw` click-to-switch
- `removeTicker(sym)`: if `sym === cfg.defaultSymbol`, also set `cfg.defaultSymbol=""` before `saveCfg()`

## Feature 2 — Market pill wording and short countdown

**Where:** `renderMarketPill()` (~1089), `countdown()` (~1107).

- Replace `countdown()` body (keep the name, it has one other caller path — check callers with a search first): floor maths as now but return `d>0 → "${d}d ${h}h"`, `h>0 → "${h}h"` (drop minutes), `m>0 → "${m}m"` (drop seconds), else `"<1m"`
- Labels in `renderMarketPill`: REGULAR → `"Closes in " + countdown(closeMs)`. Closed → `"Opens in " + countdown(no)` (plain `"Closed"` when `nextOpenMs()` returns null). Keep the dot, the `pill open/closed/pre/post` classes, and the `Pre-market` / `After-hours` labels exactly as they are
- The 1s `clockTimer` already re-renders the pill, no change needed there

## Feature 3 — Default chart timeframe 5m

**Where:** `curTf` init (~507), the `#rangeSeg` tab markup (~276 area).

- `let curTf = "5m";`
- Move the hardcoded `on` class in the `#rangeSeg` HTML from the 1m button to the 5m button
- Nothing else: `loadChart()` already fetches 5m on demand (it is what the 5m tab does today). The 1m tab still short-circuits to `lastCore`

## Feature 4 — Current price line: solid + slow breathing pulse

**Where:** `sLine` creation in `initChart()` (~829) and the `_pulseTick` interval (~875).

- Add to `sLine` options: `priceLineStyle: LightweightCharts.LineStyle.Solid` (and `priceLineWidth: 1` explicitly)
- Replace the 550ms two-state blink with a smooth sine breathe:
  ```js
  if(_pulseTick) clearInterval(_pulseTick);
  const PULSE_MS = 3200;
  _pulseTick = setInterval(()=>{
    if(!sLine || document.hidden) return;
    const ph = (Date.now() % PULSE_MS) / PULSE_MS;
    const a = 0.30 + 0.70 * (0.5 + 0.5 * Math.sin(ph * 2 * Math.PI));
    sLine.applyOptions({ priceLineColor: "rgba(45,212,191," + a.toFixed(3) + ")" });
  }, 120);
  ```
- Remove the now-unused `_pulseState` variable (search for both its uses)

## Feature 5 — Per-timeframe fit (fixes 15m/1h/1D not fitting)

**Where:** `TIMEFRAMES` (~628), `refitChart()` (~998), pane-toggle rAF block in the overlay handler (~1746), `autoFitBtn` handler (~1770).

Two compounding causes: (a) once the user drags the price scale, `autoScale` switches off and stays off for every later `setData`, which is why the series paints clipped flat at the top, and (b) `fitContent()` crams 1mo/3mo of bars into one screen. Fix both:

- Add `fitBars` to `TIMEFRAMES`: `15m: fitBars:135` (≈5 trading days), `1h(60m): fitBars:105` (≈3 weeks). 1m/5m/1D omit it (full fit is right for them)
- New single fit path:
  ```js
  function fitForTf(){
    if(!chartReady || !chart) return;
    chart.priceScale("right").applyOptions({ autoScale:true });   // clears sticky user zoom
    const fb = TIMEFRAMES[curTf] && TIMEFRAMES[curTf].fitBars;
    const n = lastChart && lastChart.bars ? lastChart.bars.length : 0;
    if(fb && n > fb) chart.timeScale().setVisibleLogicalRange({ from: n - fb - 0.5, to: n - 1 + 3 }); // 3 = rightOffset
    else chart.timeScale().fitContent();
  }
  ```
- `refitChart()` keeps its double-rAF wrapper (Pitfall 4) but calls `fitForTf()` instead of `fitContent()`
- Replace the inline double-rAF `fitContent()` in the RSI/MACD pane-toggle branch with `refitChart()`
- `autoFitBtn` keeps its "show everything" meaning: `chart.priceScale("right").applyOptions({autoScale:true}); chart.timeScale().fitContent();`

## Feature 6 — Fullscreen chart mode

**Where:** chart card markup (the `.card` wrapping `#rangeSeg`/`.toggles`/`#chartHolder`, ~270s), `applyChartHeight()` (~924), button wiring near `autoFitBtn` handler.

Deliberately an in-page overlay, not the native Fullscreen API (broken for divs on iOS Safari):

- Give the chart card `id="chartCard"`. Add an expand button next to `autoFitBtn` (same `.tgl` styling, ⛶-style SVG, `title="Fullscreen"`)
- CSS:
  ```css
  #chartCard.fs{position:fixed;inset:0;z-index:300;margin:0;border-radius:0;display:flex;flex-direction:column}
  #chartCard.fs #chartHolder{flex:1;min-height:0}
  ```
  (z-index 300 clears the topbar at 100, stays below the settings drawer at 201 only if drawer should win — it should not while fullscreen, 300 is correct)
- `applyChartHeight()`: first line, if `document.getElementById("chartCard").classList.contains("fs")` set `el.style.height="100%"` and return (the flex container sizes it, `autoSize:true` + the existing ResizeObserver handle the rest)
- Toggle handler: flip the `fs` class, `document.body.style.overflow = fs ? "hidden" : ""`, then `applyChartHeight(); refitChart();`. Add `keydown` listener for `Escape` to exit. Swap the button icon/title between enter/exit states

## Feature 7 — Pinned indicator pills + overflow dropdown

**Where:** `.toggles` markup (~278–288), overlay toggle handler (~1740), `gridBtn` handler (~1765), CSS near `.tgl` (~93–100), `DEFAULT_CFG`.

- New cfg field `pinnedOverlays: ["vwap","ema9","ema20"]`
- The toggles row becomes render-driven. New `renderToggles()`:
  - static left part: `autoFitBtn`, fullscreen button
  - one `.tgl` pill per pinned key, in `pinnedOverlays` order, with its existing colour class (`vwap`→`vwap`, `ema9`→`e9`, `ema20`→`e20`, `rs`→`rs`, `rsiPane`→`rpane`, `macdPane`→`mpane`) and `on` class from `overlays[k]`
  - a `⋯` button (`id="indMore"`) opening `#indDrop`, an absolutely positioned panel (clone the `.wl-drop` pattern: same bg/border/radius/shadow, right-aligned under the row). One row per indicator — all 7 overlay keys plus Grid: label, an on/off state (reuse the `.sw` swatch + `on` class convention), and a pin star (filled when pinned)
- Display names: VWAP, SD Bands, EMA 9, EMA 20, RS (vs SMH), RSI, MACD, Grid. Keep `data-ov` keys identical to today
- **Event delegation** (Pitfall 5): one click listener on the toggles container + one on `#indDrop`. Toggle → existing logic (`overlays[k]=!overlays[k]; applyOverlayVisibility(); cfg.overlays=…; saveCfg();` and the pane refit via `refitChart()`). Grid row → existing `gridOn` logic. Pin star → add/remove key in `cfg.pinnedOverlays`, `saveCfg()`, `renderToggles()`
- Delete the old static pill markup and the old per-node binding loop. Close `#indDrop` on outside click (same pattern the watchlist dropdown uses)
- SD Bands stays listed even when VWAP is off (visibility rule `vwap && vwapsd && intraday` in `applyOverlayVisibility` is unchanged)

## Feature 8 — Key levels: Day Hi/Lo anchors, per-level chart toggles, gauge hover

**Where:** `renderLevels()` (~1374), `updateChartLevels()` (~1360), `.lev-*` CSS, `DEFAULT_CFG`.

- **Add Day Hi / Day Lo levels:** in `renderLevels`, `add("Day Hi", core.dayHigh, "#26a69a")` and `add("Day Lo", core.dayLow, "#ef5350")` (fields exist on the core object — `dayHigh`/`dayLow` from `regularMarketDayHigh/Low`). They flow into the gauge, rows, alert buttons, and chart lines automatically
- **Anchor emphasis on the gauge:** ticks whose label is `Today Open`, `Day Hi` or `Day Lo` get class `lev-tick-a` — taller (≈14px vs 8px) and 2px wide. The current-price `.lev-pin` gets bigger: ≈18px tall, 3px wide, teal glow `box-shadow:0 0 8px rgba(45,212,191,.8)`, and the `.lev-pin-px` label bumped a size. CSS only plus the class in the tick template string
- **Per-level chart toggles:** new cfg field `levelLines: {}` (label → bool, absent = true). Each `.lev-row` gets an eye button (simple SVG, dimmed when hidden) before the Alert button. Click: flip `cfg.levelLines[lbl]`, `saveCfg()`, re-run `renderLevels(lastCore)`. `updateChartLevels(levels)` draws only `levels.filter(l => cfg.levelLines[l.lbl] !== false)`. The CARD always lists every level, only the chart lines obey the toggle. Buttons are re-created by `renderLevels` on every refresh, so wire them the same way `wireAlert` is wired (after `innerHTML` assignment)
- **Gauge hover tooltip:** give `.lev-tick` and `.lev-pin` `data-tip` (`"Prev Day Hi · $957.48"` style, price via existing `fmtPx`). One shared `#levTip` div appended inside `.lev-gauge` (make the gauge `position:relative`), styled like the tap popover (bg3, border, radius, 11px). `mouseenter`/`mousemove` on a tick shows it above the tick, clamped to the gauge width so it never overflows the card, `mouseleave` hides, `touchstart` shows for 2s. Delegate these three listeners on `#levelsList`, not per tick (the gauge re-renders every refresh)

## Feature 9 — Day-split shading on multi-day intraday charts

**Where:** `initChart()` (attach once after `sLine` creation), `paintChart()` (feed it data), new ~45-line class above `initChart`.

Highest-risk feature. Use this skeleton as-is — it is written against the v5.2.0 primitive API (`attachPrimitive`, pane views with `zOrder()`, bitmap-space drawing). It shades each bar slot of alternate ET days, per visible bar, which is robust to pan/zoom/gaps with no off-screen maths:

```js
class DayBands {
  constructor(){ this._times=[]; this._chart=null;
    this._view={ renderer:()=>this._renderer(), zOrder:()=>"bottom" }; }
  attached(p){ this._chart=p.chart; this._requestUpdate=p.requestUpdate; }
  detached(){ this._chart=null; }
  setTimes(times){ this._times=times; if(this._requestUpdate) this._requestUpdate(); }
  updateAllViews(){}
  paneViews(){ return [this._view]; }
  _renderer(){
    const chart=this._chart, times=this._times;
    if(!chart || !times.length) return null;
    const ts=chart.timeScale();
    const sp=ts.options().barSpacing || 6;
    const xs=[];
    for(const t of times){ const x=ts.timeToCoordinate(t); if(x!=null) xs.push(x); }
    if(!xs.length) return null;
    return { draw:target=>target.useBitmapCoordinateSpace(s=>{
      s.context.fillStyle="rgba(255,255,255,0.04)";
      for(const x of xs){
        const l=Math.round((x-sp/2)*s.horizontalPixelRatio);
        const r=Math.round((x+sp/2)*s.horizontalPixelRatio);
        s.context.fillRect(l,0,r-l,s.bitmapSize.height);
      }
    }) };
  }
}
```

- In `initChart()` after `sLine` is created: `dayBands=new DayBands(); sLine.attachPrimitive(dayBands);` (module-scope `let dayBands=null;` with the other series vars)
- In `paintChart(d)` after `setData`: when `tfIsIntraday(curTf) && TIMEFRAMES[curTf].range!=="1d"`, walk `bars` once with the existing `etDateKey(b.time)`, count distinct day keys in order, and collect times of bars on odd-indexed days → `dayBands.setTimes(times)`. Otherwise `dayBands.setTimes([])`
- Why per-bar slots work: adjacent bars are exactly `barSpacing` apart, so `round((x+sp/2)*hpr)` of bar i equals `round((x-sp/2)*hpr)` of bar i+1 — bands are seamless with no double-painted overlap. Coordinates are computed at draw time, so pan/zoom needs no extra wiring
- Do NOT try background colouring via extra series or DOM overlays, and do not bump the alpha above ~0.05 (it tints the area fill)

## Feature 10 — Industry / stock-type pill beside ticker name

**Where:** header `#tickWrap` markup (~225–231), `boot()` (~1829, where `#sym` is set), new const map near `DEFAULT_CFG`, `DEFAULT_CFG` itself.

- New const `TICKER_META`: compact map of ~100 liquid US tickers → `{i:"Semiconductors", s:"Cyclical", t:"Large Cap"}` (keys: `i` industry, `s` style Cyclical/Defensive/Sensitive, `t` tier Blue Chip/Large Cap/Growth/ETF). Cover at minimum: MU and major semis (NVDA AMD AVGO INTC QCOM TXN MRVL ARM TSM ASML AMAT LRCX KLAC ON NXPI), megacap tech (AAPL MSFT GOOGL AMZN META TSLA NFLX ORCL CRM ADBE NOW), finance (JPM BAC WFC GS MS V MA AXP SCHW BRK-B), healthcare (UNH LLY JNJ PFE MRK ABBV), consumer (WMT COST HD MCD NKE SBUX DIS KO PEP PG), energy/industrial (XOM CVX COP BA CAT DE GE HON LMT RTX UPS F GM), popular momentum names (PLTR COIN HOOD SNOW CRWD PANW NET DDOG UBER ABNB SHOP SQ RIVN SMCI), ETFs (SPY QQQ DIA IWM SMH SOXX XLK XLF XLE ARKK → t:"ETF"). One line per entry, keep it dense. MU = `{i:"Semiconductors", s:"Cyclical", t:"Large Cap"}`
- New cfg field `tickerMeta: {}` — per-symbol manual override, same shape, wins over the map
- Render in `boot()` right after `symEl.textContent=SYMBOL`: resolve `meta = cfg.tickerMeta[SYMBOL] || TICKER_META[SYMBOL]`. If found, inject after `#sym` two `.chip` spans: industry (class `chip b`), and `s + " · " + t` (class `chip a`). If not found, one ghost chip `+ info` in `var(--text3)`. Wrap chips in a span with `id="symMeta"` so re-render is one `innerHTML` write
- Clicking `#symMeta` opens a small popover (position absolute under the header, reuse drawer/tapPop styling): three fields — industry text input, style `<select>` (Cyclical/Defensive/Sensitive), tier `<select>` (Blue Chip/Large Cap/Growth/ETF) — prefilled from resolved meta, Save → `cfg.tickerMeta[SYMBOL]={i,s,t}; saveCfg();` re-render chips; plus a Reset row (delete the override) shown only when an override exists
- Mobile: let the tick row `flex-wrap:wrap` under 560px so chips drop to a second line instead of overflowing (`.tick .nm` already ellipsises)

## Docs and housekeeping (same change set)

- Update project `CLAUDE.md`: correct library version to v5.2.0, one short paragraph covering: default ticker resolution order, `fitForTf`/`fitBars`, `DayBands` primitive, pinned pills + `renderToggles`, `levelLines` map, `TICKER_META`/`tickerMeta`. Keep it lean, no feature marketing
- New cfg fields recap (all in `DEFAULT_CFG` so `loadCfg()` merge keeps old configs valid): `defaultSymbol:""`, `pinnedOverlays:["vwap","ema9","ema20"]`, `levelLines:{}`, `tickerMeta:{}`

## Suggested implementation order

Cheap and isolated first, risky and isolated last: Step 0 → F2 (pill text) → F3 (default 5m) → F1 (default ticker) → F4 (pulse) → F5 (fit) → F6 (fullscreen) → F7 (pinned pills) → F8 (levels) → F9 (day bands) → F10 (industry pill) → docs. Verify in browser after F5, after F8, and at the end (not after every step).

## Verification (browser, via preview tools on index.html)

The app fetches via public proxies on localhost (read-only data, the preview note is expected, fetching is NOT disabled).

1. Load with no `?symbol=` → defaults to starred ticker. Star a second ticker in the watchlist, reload bare URL, confirm it loads. Un-star → falls back to MU. `?symbol=AMD` still overrides
2. Pill: while US market closed expect `Opens in 12h` (no minutes) or `Opens in 2d 5h` on weekends, under an hour expect `Opens in 40m`. Dot and colours unchanged
3. Chart boots on 5m tab, candles… (it is a line) paints and fits. Switch 15m → last ~5 days visible, nothing clipped at the top edge, drag the price scale then switch TF → autoscale recovers. 1h → ~3 weeks. 1D → full 6mo. AutoFit button → whole range
4. Price line: solid, slow ~3s breathe, no harsh blink. Background the tab 30s → no errors, pulse resumes
5. Fullscreen: enter → card fills viewport, chart resizes and refits, page behind does not scroll. Esc and ✕ both exit, layout restores
6. Pills: only pinned show, ⋯ lists all 8 with states, toggling RSI/MACD from the dropdown grows the pane and refits, pin/unpin reorders the row, all states survive reload
7. Levels: Day Hi/Lo rows present, gauge shows tall anchor ticks + glowing price pin, hover any tick → tooltip with name and price, clamped at gauge edges. Eye-off OR15 Lo → line and axis tag vanish from the chart, row stays in card, survives reload and the next data refresh
8. Day bands: 5m/15m/1h show alternating faint day stripes that stay glued to bars while panning/zooming, 1m and 1D show none
9. Industry pill: MU shows `Semiconductors` + `Cyclical · Large Cap`. Open an unmapped ticker → `+ info` chip → fill the popover → chips render, survive reload. Edit again → Reset clears override
10. Edge cases: empty watchlist (remove all but current), weekend pill, very long company name + chips on a 375px viewport (no overflow), localStorage from v2.9 upgrades silently (no console errors on first load)

## Push (after verification passes)

Per Julian's GitHub rules: ask "OK to push to GitHub?" once, then commit straight to main with message `MU Day Trading v3.0 default ticker, chart UX, key levels, industry pill` + the Claude attribution line, and report the live URL if the repo deploys.

---

*Disposable point-in-time doc. Delete once fully actioned (see CLAUDE.md, Folder cleanliness).*
