# Insurance Module Drop-in v1 (21 Jun)

Paste-ready blocks to add an insurance tracker to the Portfolio app. Lean v1 scope: policy register, premium tracking, upcoming renewals, and a net-worth seam for cash-value policies. Gap analysis, family view, and the other extras are parked in `tasks/todo.md`.

Do not paste until the v2.5 currency-migration work has shipped, to avoid colliding with that session. Apply the seams below in order. The shared entity modal, soft-delete to trash, undo/redo, and sync all kick in automatically once the table is registered, so validation and conflict handling come for free.

Line references are as of v2.5. Three spots could not be byte-verified here and are marked **adapt on paste**: the bucket-grid wrapper class, the page-section markup, and that `showPage` routes generically. Copy how the Stocks tab does each.

## 1. Entity schema

Add inside `ENTITY_SCHEMAS`, next to `cash` and `realestate`:

```js
insurance: {
  title: 'policy',
  fields: [
    // Essentials
    { key:'insurer',  label:'Insurer', type:'text', required:true, datalist: SG_INSURERS, placeholder:'AIA' },
    { key:'plan',     label:'Plan name', type:'text', placeholder:'Living Care' },
    { key:'policyNo', label:'Policy number', type:'text' },
    { key:'type',     label:'Type', type:'select', required:true, default:'Term Life',
      options:[['Term Life','Term Life'],['Whole Life','Whole Life'],['Endowment','Endowment'],
               ['ILP','Investment-Linked'],['Critical Illness','Critical Illness'],
               ['Hospitalisation','Hospitalisation (IP)'],['Personal Accident','Personal Accident'],
               ['Disability Income','Disability Income'],['Long-term Care','CareShield / ElderShield'],
               ['Mortgage','Mortgage (HPS / MRTA)'],['Car','Car'],['Home','Home / Fire'],
               ['Travel','Travel'],['Other','Other']] },
    { key:'insured',  label:'Life insured', type:'text', required:true, placeholder:'Self' },
    { key:'status',   label:'Status', type:'select', default:'Active',
      options:[['Active','Active'],['Paid-up','Paid-up'],['Lapsed','Lapsed'],
               ['Matured','Matured'],['Surrendered','Surrendered'],['Pending','Pending']] },
    // Coverage per risk (drives later gap analysis; blank = N/A)
    { key:'coverDeath', label:'Death cover (SGD)', type:'number', step:'1', placeholder:'500000' },
    { key:'coverTPD',   label:'TPD cover (SGD)', type:'number', step:'1' },
    { key:'coverCI',    label:'Critical illness cover (SGD)', type:'number', step:'1' },
    { key:'coverHosp',  label:'Hospital ward', type:'select', default:'',
      options:[['','— n/a —'],['B1','Public B1'],['A','Public A'],['Private','Private'],['As-charged','As-charged']] },
    { key:'coverIncomeMonthly', label:'Disability income (monthly benefit, SGD)', type:'number', step:'1' },
    { key:'coverLTCMonthly',    label:'Long-term care (monthly payout, SGD)', type:'number', step:'1' },
    // Premium
    { key:'premium',     label:'Premium (per payment)', type:'number', step:'0.01', placeholder:'1200' },
    { key:'premiumFreq', label:'Frequency', type:'select', default:'Annual',
      options:[['Monthly','Monthly'],['Quarterly','Quarterly'],['Semi-annual','Semi-annual'],['Annual','Annual'],['Single','Single premium']] },
    { key:'premiumMode', label:'Paid from', type:'select', default:'Cash',
      options:[['Cash','Cash / GIRO'],['Card','Credit card'],['MediSave','MediSave'],['CPF','CPF (DPS)'],['Other','Other']],
      hint:'MediSave / CPF premiums are excluded from your cash premium outlay.' },
    { key:'premiumDue',  label:'Next premium / renewal date', type:'date', hint:'Drives the upcoming-renewals card.' },
    // Value (feeds net worth; whole life / endowment / ILP only)
    { key:'cashValue', label:'Current cash / surrender value (SGD)', type:'number', step:'0.01',
      hint:'Counts toward net worth. Leave blank for term and health policies.' },
    { key:'maturityValue', label:'Projected maturity value (SGD)', type:'number', step:'1' },
    // Extras
    { key:'beneficiary', label:'Nominee(s)', type:'text' },
    { key:'docUrl',      label:'Policy document link', type:'text', placeholder:'https://...' },
    { key:'notes',       label:'Notes', type:'textarea' }
  ],
  defaults: { type:'Term Life', status:'Active', premiumFreq:'Annual', premiumMode:'Cash' },
  afterRead: (item) => { item.currency = 'SGD'; item.updatedAt = new Date().toISOString(); }
}
```

## 1a. Singapore insurer autocomplete

The insurer field offers the major SG insurers as suggestions, but stays free text so a foreign insurer or broker can still be typed. Add the constant next to the schema:

```js
// Major Singapore insurers (life, health, general). Drives autocomplete only,
// any name can still be entered.
const SG_INSURERS = ['AIA','Prudential','Great Eastern','Income','Singlife','Manulife',
  'HSBC Life','Tokio Marine','China Taiping','Etiqa','FWD','Raffles Health Insurance',
  'MSIG','AIG','Allianz','Chubb','Sompo','Liberty','QBE'];
```

Then teach `renderField` (~line 4034) to emit a datalist when a text field carries one. This replaces the existing `else` branch and is backward-compatible, fields without `datalist` render exactly as before:

```js
} else {
  const step = f.step ? ` step="${kjrEscape(f.step)}"` : '';
  const min  = f.min != null ? ` min="${kjrEscape(f.min)}"` : '';
  const inputType = f.type === 'number' ? 'number' : (f.type === 'date' ? 'date' : 'text');
  let listAttr = '', listEl = '';
  if (Array.isArray(f.datalist) && f.datalist.length){
    const listId = 'dl-' + f.key;
    listAttr = ` list="${listId}"`;
    listEl = `<datalist id="${listId}">${f.datalist.map(o => `<option value="${kjrEscape(o)}"></option>`).join('')}</datalist>`;
  }
  input = `<input class="fi" type="${inputType}" data-fkey="${f.key}"${step}${min}${listAttr} value="${safeV}" placeholder="${kjrEscape(f.placeholder||'')}"${required}>` + listEl;
}
```

`entityModalSave` needs no change. Text fields are sanitised as free strings, so an insurer typed outside the list saves fine.

## 2. Register the table

```js
// _LIST_TABLES: append
const _LIST_TABLES = [/* ...existing... */, 'insurance'];

// TRASH_TABLE_NAMES: add
insurance: 'Policy',

// freshDB(): add to the empty-table list
insurance: [],
```

## 3. Derived helpers

```js
const PREMIUM_PER_YEAR = { Monthly:12, Quarterly:4, 'Semi-annual':2, Annual:1, Single:0 };
function annualPremium(p){ return (Number(p.premium)||0) * (PREMIUM_PER_YEAR[p.premiumFreq] ?? 1); }
// Cash outlay only; MediSave / CPF premiums are not out of pocket.
function cashPremiumPerYear(p){ return ['Cash','Card'].includes(p.premiumMode) ? annualPremium(p) : 0; }
// Net-worth seam: active cash-value policies only.
function insuranceCashValueSGD(){
  return (DB.insurance||[]).filter(p => p.status==='Active')
    .reduce((s,p) => s + toSGD(Number(p.cashValue)||0, p.currency||'SGD'), 0);
}
```

## 4. Net-worth seam

Cash-value policies are an asset class. Wire into the three net-worth spots:

```js
// _netWorthClassesSGD()  (~line 6478): add the key
insurance: insuranceCashValueSGD(),

// currentNetWorthSGD()  (~line 6489): add to the sum, guard for old snapshots
return c.stocks + c.cash + c.cpf + c.realestate + c.crypto + (c.insurance||0);

// takeSnapshot()  (~line 6495): same addition
const net = byClass.stocks + byClass.cash + byClass.cpf + byClass.realestate + byClass.crypto + (byClass.insurance||0);
```

Old snapshots predate the key, so the `|| 0` guard is required. They show no insurance bucket historically, which is correct, it was not tracked then. New snapshots carry it forward.

## 5. Render

```js
/* INSURANCE — policy register, premium summary, upcoming renewals.
   No live feed: cash value is user-entered. SGD throughout. */
function renderInsurance(){
  const el = document.getElementById('insurance-root');
  if (!el) return;
  const list = (DB.insurance || []).slice();

  const head = `
    <div class="card"><div class="card-head">
      <h3>Insurance</h3>
      <button class="btn btn-primary btn-sm" onclick="openEntityModal('insurance')">＋ Add policy</button>
    </div>`;

  if (!list.length){
    el.innerHTML = head + `<div class="card-body"><div class="empty">
      <div class="empty-icon">🛡️</div><div class="empty-title">No policies yet</div>
      <div class="empty-sub">Track life, health, and general policies. Premiums, renewal dates, and any cash value feed your dashboard.</div>
    </div></div></div>`;
    return;
  }

  // Summary across active policies.
  const active = list.filter(p => p.status === 'Active');
  const cashYr    = active.reduce((s,p) => s + cashPremiumPerYear(p), 0);
  const nonCashYr = active.reduce((s,p) => s + (annualPremium(p) - cashPremiumPerYear(p)), 0);
  const cover = k => active.reduce((s,p) => s + (Number(p[k])||0), 0);

  // adapt on paste: swap .buckets for the Dashboard's bucket-grid wrapper class.
  const summary = `<div class="card-body"><div class="buckets">
    <div class="bucket"><div class="bucket-label">Annual premium (cash)</div><div class="bucket-amt">${fmt(cashYr,{dp:0})}</div></div>
    <div class="bucket"><div class="bucket-label">From MediSave / CPF</div><div class="bucket-amt">${fmt(nonCashYr,{dp:0})}</div></div>
    <div class="bucket"><div class="bucket-label">Death cover</div><div class="bucket-amt">${fmt(cover('coverDeath'),{dp:0})}</div></div>
    <div class="bucket"><div class="bucket-label">CI cover</div><div class="bucket-amt">${fmt(cover('coverCI'),{dp:0})}</div></div>
  </div>`;

  // Register table (reuses table.holdings styles + the .row-actions fix).
  const rows = list.sort((a,b) => String(a.insurer||'').localeCompare(String(b.insurer||'')))
    .map(p => `<tr>
      <td class="tl cell-sym sticky-col">${kjrEscape(p.insurer || '?')}</td>
      <td class="tl">${kjrEscape(p.type || '')}</td>
      <td class="tl">${kjrEscape(p.insured || '')}</td>
      <td class="tl">${kjrEscape(p.status || '')}</td>
      <td class="num">${p.coverDeath ? fmt(Number(p.coverDeath),{dp:0}) : '—'}</td>
      <td class="num">${p.premium ? fmt(annualPremium(p),{dp:0}) + '/yr' : '—'}</td>
      <td class="num">${p.premiumDue ? fmtDateSG(p.premiumDue) : '—'}</td>
      <td class="num">${p.cashValue ? fmt(Number(p.cashValue),{dp:0}) : '—'}</td>
      <td class="row-actions">
        <button class="btn btn-sm btn-ghost btn-edit" data-edit-table="insurance" data-edit-id="${kjrEscape(p.id)}">Edit</button>
      </td>
    </tr>`).join('');

  const table = `<div class="tbl-wrap"><table class="holdings">
    <thead><tr>
      <th class="tl sticky-col">Insurer</th><th class="tl">Type</th><th class="tl">Insured</th>
      <th class="tl">Status</th><th>Death cover</th><th>Premium</th><th>Next due</th><th>Cash value</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table></div></div>`;

  // Upcoming premiums / renewals, next 90 days.
  const today = new Date();
  const horizon = new Date(today.getTime() + 90*864e5);
  const due = list.filter(p => p.premiumDue && new Date(p.premiumDue) >= today && new Date(p.premiumDue) <= horizon)
    .sort((a,b) => String(a.premiumDue).localeCompare(String(b.premiumDue)));
  let renew = '';
  if (due.length){
    renew = `<div class="card" style="margin-top:16px"><div class="card-head"><h3>Upcoming premiums <span class="page-sub">next 90 days</span></h3></div>
      <div class="card-body"><div class="tbl-wrap"><table class="holdings"><tbody>
      ${due.map(p => `<tr>
        <td class="tl cell-sym">${kjrEscape(p.insurer||'?')}</td>
        <td class="tl">${kjrEscape(p.plan||p.type||'')}</td>
        <td class="num">${fmtDateSG(p.premiumDue)} (in ${Math.max(0, Math.ceil((new Date(p.premiumDue)-today)/864e5))}d)</td>
        <td class="num">${p.premium ? fmt(Number(p.premium),{dp:0}) : '—'}</td>
      </tr>`).join('')}
      </tbody></table></div></div></div>`;
  }

  el.innerHTML = head + summary + table + renew;
}
```

## 6. Nav and routing

```html
<!-- nav: copy a sibling nav-btn, add an icon -->
<button class="nav-btn" data-tab="insurance">Insurance</button>

<!-- page section: adapt on paste to match the Stocks page wrapper -->
<section class="page" id="page-insurance"><div id="insurance-root"></div></section>
```

```js
// renderAll(): add the call alongside renderStocks() etc.
renderInsurance();
```

`showPage` routes by `data-tab` / page id, so no change there if it is generic (adapt on paste if it is a switch).

## 7. CSV export (optional)

Mirror `exportHoldingsCSV`: headers = insurer, plan, policyNo, type, insured, status, coverDeath, coverCI, annual premium, premiumMode, premiumDue, cashValue. Feed rows from `DB.insurance` and reuse `downloadCSV`.

## 8. Coverage adequacy (recommended-coverage metric)

Tells you whether you are sufficiently covered, per risk, against income-multiple benchmarks. Income-multiple method, six risks, one card on the Insurance tab. A rule-of-thumb guide, not personalised advice.

### Targets and settings

```js
// Recommended-coverage benchmarks. Rules of thumb, editable in Settings.
// death/TPD/CI are multiples of ANNUAL income; income protection is a % of
// MONTHLY income (a monthly benefit); LTC is a flat monthly target.
const COVERAGE_TARGETS_DEFAULT = {
  deathMult: 10,            // x annual income (LIA gap study ~9x, common 10x)
  tpdMult: 10,              // x annual income, set equal to death
  ciMult: 4,                // x annual income (LIA ~3.9x)
  incomeProtectionPct: 60,  // % of monthly income replaced
  ltcMonthlyTarget: 2500,   // SGD/month long-term care payout
  hospTargetWard: 'A',      // minimum Integrated Shield ward to count as covered
  includeCareShieldBase: false // add a ~600/mo CareShield Life base to LTC current
};
function coverageTargets(){ return Object.assign({}, COVERAGE_TARGETS_DEFAULT, DB.settings.coverageTargets || {}); }
function setCoverageTarget(key, val){
  DB.settings.coverageTargets = Object.assign({}, DB.settings.coverageTargets, { [key]: val });
  saveData(); renderInsurance();
}
```

Expose these in the Settings page as a "Coverage targets" group of number inputs bound via `setCoverageTarget`, mirroring the existing target-allocation controls. `coverageTargets()` falls back to the defaults if `DB.settings.coverageTargets` is absent, so adding it to `freshDB().settings` is optional.

### Annual income (reuses DB.income)

```js
// Annual gross income in SGD. With a full year of data, use the trailing-12
// total (captures bonuses once); with less, annualise the average monthly
// gross. 0 when nothing is logged, which trips the card's empty state.
function annualIncomeSGD(){
  const inc = (DB.income || []).filter(i => i.date && isFinite(Number(i.gross)));
  if (!inc.length) return 0;
  const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutISO = _isoDateSG(cutoff);
  let rows = inc.filter(i => i.date >= cutISO);
  if (!rows.length) rows = inc;                    // no recent data, fall back to all-time
  const byMonth = {};
  rows.forEach(i => { const m = String(i.date).slice(0,7); byMonth[m] = (byMonth[m]||0) + (Number(i.gross)||0); });
  const months = Object.keys(byMonth).length || 1;
  const total  = Object.values(byMonth).reduce((s,v) => s + v, 0);
  return months >= 12 ? total : (total / months) * 12;
}
```

### Compute

```js
function _selfPolicies(){
  return (DB.insurance || []).filter(p => p.status === 'Active' && (!p.insured || /^self$/i.test(p.insured)));
}
function coverageAdequacy(){
  const t = coverageTargets();
  const annual = annualIncomeSGD();
  const monthly = annual / 12;
  const pol = _selfPolicies();
  const sum = k => pol.reduce((s,p) => s + (Number(p[k])||0), 0);
  const WARD_RANK = { '':0, B1:1, A:2, Private:3, 'As-charged':3 };
  const hasIP = pol.some(p => p.type === 'Hospitalisation' && (WARD_RANK[p.coverHosp]||0) >= (WARD_RANK[t.hospTargetWard]||0));
  const ltcCurrent = sum('coverLTCMonthly') + (t.includeCareShieldBase ? 600 : 0);

  const risks = [
    { key:'death',  label:'Death',             unit:'sum',  target: annual * t.deathMult, current: sum('coverDeath') },
    { key:'tpd',    label:'Total disability',  unit:'sum',  target: annual * t.tpdMult,   current: sum('coverTPD') },
    { key:'ci',     label:'Critical illness',  unit:'sum',  target: annual * t.ciMult,    current: sum('coverCI') },
    { key:'hosp',   label:'Hospitalisation',   unit:'bool', target: 1, current: hasIP ? 1 : 0 },
    { key:'income', label:'Income protection', unit:'mo',   target: monthly * t.incomeProtectionPct / 100, current: sum('coverIncomeMonthly') },
    { key:'ltc',    label:'Long-term care',    unit:'mo',   target: t.ltcMonthlyTarget,   current: ltcCurrent }
  ].map(r => {
    // income-based risks need income logged; LTC has a fixed target; hosp is always assessable
    const assessed = r.unit === 'bool' || r.key === 'ltc' || annual > 0;
    const ratio = r.target > 0 ? Math.min(1, r.current / r.target) : (r.current > 0 ? 1 : 0);
    const gap = Math.max(0, r.target - r.current);
    let status = 'na';
    if (assessed) status = r.unit === 'bool' ? (r.current ? 'covered' : 'gap')
                         : ratio >= 1 ? 'covered' : ratio >= 0.5 ? 'partial' : 'gap';
    return Object.assign(r, { ratio, gap, assessed, status });
  });

  const ratios = risks.filter(r => r.assessed).map(r => r.unit === 'bool' ? (r.current ? 1 : 0) : r.ratio);
  const score = ratios.length ? Math.round(ratios.reduce((s,v) => s + v, 0) / ratios.length * 100) : null;
  const weakest = risks.filter(r => r.assessed && r.status !== 'covered').sort((a,b) => a.ratio - b.ratio)[0] || null;
  return { annual, monthly, risks, score, weakest };
}
```

### Render

Append `+ renderCoverageAdequacy()` to the `el.innerHTML` stack at the end of `renderInsurance` (after `renew`).

```js
function renderCoverageAdequacy(){
  const a = coverageAdequacy();
  if (a.annual <= 0 && !_selfPolicies().length){
    return `<div class="card" style="margin-top:16px"><div class="card-head"><h3>Protection adequacy</h3></div>
      <div class="card-body"><div class="empty"><div class="empty-icon">🧭</div>
      <div class="empty-title">Add income and policies to see your gaps</div>
      <div class="empty-sub">Targets are based on your annual income. Log income on the Cashflow tab and add your policies above.</div>
    </div></div></div>`;
  }
  const t = coverageTargets();
  const cur = r => r.unit === 'bool' ? (r.current ? 'Yes' : 'No') : fmt(r.current,{dp:0}) + (r.unit === 'mo' ? '/mo' : '');
  const tgt = r => !r.assessed ? '—' : r.unit === 'bool' ? ('Ward ' + t.hospTargetWard + '+') : fmt(r.target,{dp:0}) + (r.unit === 'mo' ? '/mo' : '');
  const PILL = { covered:['covered','✓ Covered'], partial:['partial','◐ Partial'], gap:['gap','✕ Under-insured'], na:['na','– Not assessed'] };
  const rows = a.risks.map(r => {
    const [cls,lbl] = PILL[r.status];
    const bar = (r.assessed && r.unit !== 'bool')
      ? `<div class="cov-bar"><span style="width:${Math.round(r.ratio*100)}%"></span></div>` : '';
    return `<tr>
      <td class="tl">${r.label}</td>
      <td class="num">${cur(r)}</td>
      <td class="num">${tgt(r)}</td>
      <td class="num">${(r.assessed && r.gap > 0 && r.unit !== 'bool') ? fmt(r.gap,{dp:0}) + (r.unit === 'mo' ? '/mo' : '') : '—'}</td>
      <td class="tl">${bar}<span class="cov-pill ${cls}">${lbl}</span></td>
    </tr>`;
  }).join('');
  const head = a.score == null ? 'Add income to score'
    : `Protection score ${a.score}%` + (a.weakest ? ` · weakest: ${a.weakest.label}` : '');
  return `<div class="card" style="margin-top:16px">
    <div class="card-head"><h3>Protection adequacy</h3><span class="page-sub">${head}</span></div>
    <div class="card-body">
      <div class="tbl-wrap"><table class="holdings"><thead><tr>
        <th class="tl">Risk</th><th>Current</th><th>Recommended</th><th>Gap</th><th class="tl">Status</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint" style="margin-top:10px">Rule-of-thumb guide using income multiples (death and TPD 10x, CI 4x annual income, income protection 60% of monthly income). Not personalised financial advice, see a licensed adviser for a full needs analysis. Targets are editable in Settings.</p>
    </div></div>`;
}
```

### CSS (add near the insurance styles)

```css
.cov-bar{display:inline-block;width:80px;height:6px;border-radius:3px;background:var(--bg3);overflow:hidden;vertical-align:middle;margin-right:8px}
.cov-bar span{display:block;height:100%;background:var(--accent)}
.cov-pill{display:inline-block;font-size:11px;font-weight:700;padding:1px 8px;border-radius:8px;border:1px solid transparent;white-space:nowrap}
.cov-pill.covered{color:var(--green);background:var(--green-soft);border-color:var(--green-border)}
.cov-pill.partial{color:var(--amber);background:var(--amber-soft);border-color:var(--amber-border)}
.cov-pill.gap{color:var(--red);background:var(--red-soft);border-color:var(--red-border)}
.cov-pill.na{color:var(--text3);background:var(--bg4);border-color:var(--border2)}
```

### Worked example (hand-checked)

Annual income SGD 96,000 (avg 8,000/mo gross). One active policy: 500,000 death cover, IP at ward A, nothing else.

| Risk | Current | Recommended | Ratio | Status |
|---|---|---|---|---|
| Death | 500,000 | 960,000 | 52% | Partial |
| Total disability | 0 | 960,000 | 0% | Under-insured |
| Critical illness | 0 | 384,000 | 0% | Under-insured |
| Hospitalisation | Yes | Ward A+ | n/a | Covered |
| Income protection | 0/mo | 4,800/mo | 0% | Under-insured |
| Long-term care | 0/mo | 2,500/mo | 0% | Under-insured |

Protection score = average(52, 0, 0, 100, 0, 0) = 25%, weakest area Total disability. Death 500,000 / 960,000 = 52%, Partial, matches the plan.

## Schema version

The v2.5 work took `SCHEMA_VERSION` to 2. A new empty table needs no migration. If you later add gap-target settings, bump to 3 with a defaults migration, not 2, so the two work streams do not claim the same version.

## Quality bar (covered by reuse)

- validation, required fields, number and date sanitising: shared `entityModalSave`
- no silent loss: soft-delete to trash, `pushUndo`, dirty-set sync
- empty state: built into `renderInsurance`
- mobile: reuses `table.holdings` responsive styles, no drag-only controls

*Disposable point-in-time doc. Delete once fully actioned (see CLAUDE.md, Folder cleanliness).*
