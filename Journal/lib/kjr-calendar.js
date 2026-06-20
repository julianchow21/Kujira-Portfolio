/* ═══════════════════════════════════════════════════════════════════════
   KUJIRA SHARED — kjr-calendar.js   (KJR_CALENDAR_VERSION 1.0)
   One month-calendar engine, configured per app, never forked.
   Loaded by a plain <script src="kjr-calendar.js?v=1.0"> after kjr-format.js.
   Exposes window.KjrCalendar.mount(el, opts) -> { refresh, goToMonth, today, destroy }.

   The engine OWNS: the month grid (week-start rotation, lead/trail padding),
   prev/today/next nav, today highlight, day-of-week header, the .cal-cell /
   .cal-daynum / .cal-chips scaffold and its CSS (injected once, theme tokens
   only), click delegation (tap-first, works on touch), and keyboard nav.

   The APP injects (all optional unless noted):
     weekStart      0 Sun .. 1 Mon (default 1)
     initialMonth   Date in the month to show first (default today)
     getEvents(startISO, endISO) -> { 'YYYY-MM-DD': [event, ...] }  (events are
                    opaque to the engine; it only hands them back to your hooks)
     renderChips(iso, events, ctx) -> escaped chip HTML for a day
                    ctx = { isToday, isOutOfMonth, esc, eventActions(idx) }
     renderCell(iso, events, ctx)  -> full cell inner HTML (overrides renderChips)
     renderSummary(events, ctx)    -> header sub-line HTML (default: month label)
     renderAbove(events, ctx) / renderBelow(events, ctx) -> HTML around the grid
     onDayClick(iso, events)       tap / click / Enter on a day
     onEventClick(ev, iso)         click on an element marked data-cal-event="idx"
     onEventEdit(ev, iso)          pencil affordance, shown only if supplied
     onEventDelete(ev, iso)        delete affordance, shown only if supplied
     onMonthChange(Date)           fired when the visible month changes
     title                         header title (default 'Calendar')

   Per-app variation lives in this config. Re-skin via CSS tokens, never fork.
   Vendored copy — improve the master in the template, bump the version, re-vendor.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var VERSION = '1.0';
  var F = root.KjrFmt;

  function pad(n) { return (F && F.pad) ? F.pad(n) : String(n).padStart(2, '0'); }
  function esc(s) {
    if (F && F.esc) return F.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function todayISO() {
    if (F && F.todayISO) return F.todayISO();
    var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function isoFromYMD(y, m0, d) { return (F && F.isoFromYMD) ? F.isoFromYMD(y, m0, d) : y + '-' + pad(m0 + 1) + '-' + pad(d); }

  var BASE_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function dowLabels(weekStart) { var a = []; for (var i = 0; i < 7; i++) a.push(BASE_DOW[(weekStart + i) % 7]); return a; }

  /* Structural CSS, injected once. Theme tokens with fallbacks so a missing
     token degrades gracefully. Mobile overrides come AFTER the base rules
     (a later equal-specificity base rule beats an earlier @media rule). */
  var CSS_ID = 'kjr-cal-css';
  var CSS = '' +
    '.kjrcal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 16px;border-bottom:1px solid var(--border,#2a2a2a)}' +
    '.kjrcal-title{font-size:15px;font-weight:600;margin:0}' +
    '.kjrcal-sub{font-size:12px;color:var(--text3,#666);font-weight:400;margin-top:2px}' +
    '.kjrcal-nav-wrap{display:flex;gap:8px;align-items:center}' +
    '.kjrcal-nav{padding:5px 10px;font-size:12px}' +
    '.kjrcal-body{padding:16px;overflow:hidden}' +
    '.cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}' +
    '.cal-dow{font-size:11px;text-transform:uppercase;letter-spacing:.3px;color:var(--text3,#666);text-align:center;padding:2px 0 6px;font-weight:600}' +
    '.cal-cell{min-height:84px;border:1px solid var(--border,#2a2a2a);border-radius:var(--radius,8px);background:var(--bg3,#1e1e1e);padding:6px;cursor:pointer;display:flex;flex-direction:column;gap:4px;transition:background .15s,border-color .15s}' +
    '.cal-cell:hover{background:var(--bg4,#252525)}' +
    '.cal-cell:focus{outline:none;border-color:var(--accent,#2dd4bf);box-shadow:inset 0 0 0 1px var(--accent,#2dd4bf)}' +
    '.cal-cell.out{opacity:.38}' +
    '.cal-cell.today{border-color:var(--accent,#2dd4bf);box-shadow:inset 0 0 0 1px var(--accent,#2dd4bf)}' +
    '.cal-daynum{font-size:12px;font-weight:700;color:var(--text2,#999)}' +
    '.cal-cell.today .cal-daynum{color:var(--accent,#2dd4bf)}' +
    '.cal-chips{display:flex;flex-direction:column;align-items:flex-start;gap:3px;overflow:hidden}' +
    '.cal-chip{display:inline-flex;align-items:center;gap:3px;max-width:100%;font-size:10.5px;font-weight:600;padding:1px 6px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid transparent;background:var(--bg4,#252525);color:var(--text2,#999)}' +
    '.kjrcal-act{border:none;background:none;cursor:pointer;color:var(--text3,#666);font-size:11px;padding:0 2px;line-height:1}' +
    '.kjrcal-act:hover{color:var(--text,#e8e8e8)}' +
    '@media(max-width:640px){' +
      '.cal-grid{gap:3px}' +
      '.cal-cell{min-height:60px;padding:4px}' +
      '.cal-chip{font-size:9px;padding:1px 4px}' +
      '.cal-dow{font-size:9px}' +
    '}';
  function injectCSS() {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function Cal(el, opts) {
    this.el = el;
    this.opts = opts || {};
    this.weekStart = (this.opts.weekStart == null) ? 1 : this.opts.weekStart;
    var im = this.opts.initialMonth ? new Date(this.opts.initialMonth) : new Date();
    this.month = new Date(im.getFullYear(), im.getMonth(), 1);
    this.eventsMap = {};
    this.cells = [];
    this.focusIdx = -1;
    this._click = this._onClick.bind(this);
    this._key = this._onKey.bind(this);
    this.el.addEventListener('click', this._click);
    this.el.addEventListener('keydown', this._key);
  }

  Cal.prototype._computeCells = function () {
    var y = this.month.getFullYear(), mo = this.month.getMonth();
    var first = new Date(y, mo, 1);
    var lead = (first.getDay() - this.weekStart + 7) % 7;
    var dim = new Date(y, mo + 1, 0).getDate();
    var cells = [];
    for (var i = 0; i < lead; i++) cells.push({ d: new Date(y, mo, 1 - (lead - i)), out: true });
    for (var n = 1; n <= dim; n++) cells.push({ d: new Date(y, mo, n), out: false });
    while (cells.length % 7 !== 0) { var l = cells[cells.length - 1].d; cells.push({ d: new Date(l.getFullYear(), l.getMonth(), l.getDate() + 1), out: true }); }
    cells.forEach(function (c) { c.iso = isoFromYMD(c.d.getFullYear(), c.d.getMonth(), c.d.getDate()); });
    return cells;
  };

  Cal.prototype._eventActions = function (idx) {
    var o = this.opts, out = '';
    if (typeof o.onEventEdit === 'function') out += '<button type="button" class="kjrcal-act" data-cal-edit="' + idx + '" aria-label="Edit">✎</button>';
    if (typeof o.onEventDelete === 'function') out += '<button type="button" class="kjrcal-act" data-cal-delete="' + idx + '" aria-label="Delete">✕</button>';
    return out;
  };

  Cal.prototype.render = function () {
    var o = this.opts, self = this;
    var y = this.month.getFullYear(), mo = this.month.getMonth();
    var monthLabel = this.month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    var cells = this.cells = this._computeCells();
    var startISO = cells[0].iso, endISO = cells[cells.length - 1].iso;
    var ev = (typeof o.getEvents === 'function') ? (o.getEvents(startISO, endISO) || {}) : {};
    this.eventsMap = ev;
    var t = todayISO();
    var ctx = { year: y, month: mo, startISO: startISO, endISO: endISO, monthLabel: monthLabel, events: ev, today: t, esc: esc };

    var summary = (typeof o.renderSummary === 'function') ? o.renderSummary(ev, ctx) : esc(monthLabel);
    var above = (typeof o.renderAbove === 'function') ? (o.renderAbove(ev, ctx) || '') : '';
    var below = (typeof o.renderBelow === 'function') ? (o.renderBelow(ev, ctx) || '') : '';
    var title = o.title || 'Calendar';

    var dows = dowLabels(this.weekStart).map(function (d) { return '<div class="cal-dow">' + esc(d) + '</div>'; }).join('');
    var grid = cells.map(function (c, idx) {
      var events = ev[c.iso] || [];
      var cellCtx = { isToday: c.iso === t, isOutOfMonth: c.out, esc: esc, eventActions: function (i) { return self._eventActions(i); } };
      var inner;
      if (typeof o.renderCell === 'function') {
        inner = o.renderCell(c.iso, events, cellCtx);
      } else {
        var chips = (typeof o.renderChips === 'function') ? (o.renderChips(c.iso, events, cellCtx) || '') : '';
        inner = '<div class="cal-daynum">' + c.d.getDate() + '</div><div class="cal-chips">' + chips + '</div>';
      }
      var cls = 'cal-cell' + (c.out ? ' out' : '') + (c.iso === t ? ' today' : '');
      return '<div class="' + cls + '" role="gridcell" data-iso="' + c.iso + '" data-idx="' + idx + '" tabindex="-1">' + inner + '</div>';
    }).join('');

    this.el.classList.add('kjrcal');
    this.el.innerHTML =
      '<div class="kjrcal-head"><div><h3 class="kjrcal-title">' + esc(title) + '</h3><div class="kjrcal-sub">' + summary + '</div></div>' +
      '<div class="kjrcal-nav-wrap">' +
        '<button type="button" class="btn kjrcal-nav" data-cal-nav="-1" aria-label="Previous month">‹</button>' +
        '<button type="button" class="btn kjrcal-nav" data-cal-nav="0">Today</button>' +
        '<button type="button" class="btn kjrcal-nav" data-cal-nav="1" aria-label="Next month">›</button>' +
      '</div></div>' +
      '<div class="kjrcal-body">' + above + '<div class="cal-grid" role="grid">' + dows + grid + '</div>' + below + '</div>';

    this._setTabstop();
  };

  /* Choose the roving-tabindex cell: keep the current one if still valid, else
     today, else the first in-month day. */
  Cal.prototype._setTabstop = function () {
    var cells = this.el.querySelectorAll('.cal-cell');
    if (!cells.length) return;
    var idx = this.focusIdx, i;
    if (idx < 0 || idx >= cells.length) {
      var t = todayISO(); idx = -1;
      for (i = 0; i < this.cells.length; i++) { if (this.cells[i].iso === t && !this.cells[i].out) { idx = i; break; } }
      if (idx < 0) for (i = 0; i < this.cells.length; i++) { if (!this.cells[i].out) { idx = i; break; } }
      if (idx < 0) idx = 0;
    }
    this.focusIdx = idx;
    cells[idx].setAttribute('tabindex', '0');
  };

  Cal.prototype._focusByIndex = function (i) {
    var cells = this.el.querySelectorAll('.cal-cell');
    if (i < 0 || i >= cells.length) return;
    if (cells[this.focusIdx]) cells[this.focusIdx].setAttribute('tabindex', '-1');
    this.focusIdx = i;
    cells[i].setAttribute('tabindex', '0');
    cells[i].focus();
  };

  Cal.prototype._focusFirstInMonth = function () {
    for (var i = 0; i < this.cells.length; i++) { if (!this.cells[i].out) { this._focusByIndex(i); return; } }
  };

  Cal.prototype._onClick = function (e) {
    var o = this.opts;
    var nav = e.target.closest('[data-cal-nav]');
    if (nav && this.el.contains(nav)) { this.shift(parseInt(nav.getAttribute('data-cal-nav'), 10)); return; }
    var cell = e.target.closest('.cal-cell');
    if (!cell || !this.el.contains(cell)) return;
    var iso = cell.getAttribute('data-iso');
    var events = this.eventsMap[iso] || [];
    var editBtn = e.target.closest('[data-cal-edit]');
    if (editBtn && typeof o.onEventEdit === 'function') { e.stopPropagation(); o.onEventEdit(events[+editBtn.getAttribute('data-cal-edit')], iso); return; }
    var delBtn = e.target.closest('[data-cal-delete]');
    if (delBtn && typeof o.onEventDelete === 'function') { e.stopPropagation(); o.onEventDelete(events[+delBtn.getAttribute('data-cal-delete')], iso); return; }
    var evEl = e.target.closest('[data-cal-event]');
    if (evEl && typeof o.onEventClick === 'function') { o.onEventClick(events[+evEl.getAttribute('data-cal-event')], iso); return; }
    if (typeof o.onDayClick === 'function') o.onDayClick(iso, events);
  };

  Cal.prototype._onKey = function (e) {
    var cell = e.target.closest('.cal-cell');
    if (!cell || !this.el.contains(cell)) return;
    var idx = parseInt(cell.getAttribute('data-idx'), 10);
    var k = e.key, move = 0;
    if (k === 'ArrowLeft') move = -1;
    else if (k === 'ArrowRight') move = 1;
    else if (k === 'ArrowUp') move = -7;
    else if (k === 'ArrowDown') move = 7;
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); var iso = cell.getAttribute('data-iso'); if (typeof this.opts.onDayClick === 'function') this.opts.onDayClick(iso, this.eventsMap[iso] || []); return; }
    else if (k === 'PageUp') { e.preventDefault(); this.shift(-1); this._focusFirstInMonth(); return; }
    else if (k === 'PageDown') { e.preventDefault(); this.shift(1); this._focusFirstInMonth(); return; }
    else return;
    e.preventDefault();
    var cells = this.el.querySelectorAll('.cal-cell');
    var ni = idx + move;
    if (ni < 0 || ni >= cells.length) return;   // clamp at grid edges
    this._focusByIndex(ni);
  };

  Cal.prototype._emitMonth = function () { if (typeof this.opts.onMonthChange === 'function') this.opts.onMonthChange(new Date(this.month)); };

  Cal.prototype.shift = function (n) {
    if (n === 0) { var d = new Date(); this.month = new Date(d.getFullYear(), d.getMonth(), 1); }
    else this.month = new Date(this.month.getFullYear(), this.month.getMonth() + n, 1);
    this.focusIdx = -1;
    this._emitMonth();
    this.render();
  };
  Cal.prototype.goToMonth = function (date) { var d = new Date(date); this.month = new Date(d.getFullYear(), d.getMonth(), 1); this.focusIdx = -1; this._emitMonth(); this.render(); };
  Cal.prototype.today = function () { this.shift(0); };
  Cal.prototype.refresh = function () { this.render(); };
  Cal.prototype.destroy = function () {
    this.el.removeEventListener('click', this._click);
    this.el.removeEventListener('keydown', this._key);
    this.el.innerHTML = '';
    this.el.classList.remove('kjrcal');
  };

  function mount(el, opts) {
    if (!el) throw new Error('KjrCalendar.mount: missing element');
    injectCSS();
    var inst = new Cal(el, opts);
    inst.render();
    return {
      refresh: function () { inst.refresh(); },
      goToMonth: function (d) { inst.goToMonth(d); },
      today: function () { inst.today(); },
      destroy: function () { inst.destroy(); },
      get month() { return new Date(inst.month); },
      el: el
    };
  }

  root.KjrCalendar = { mount: mount, esc: esc, VERSION: VERSION };
})(typeof self !== 'undefined' ? self : this);
