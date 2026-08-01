/* ═══════════════════════════════════════════════════════════════════════
   KUJIRA SHARED, kjr-format.js   (KJR_FORMAT_VERSION 1.2)
   Pure, side-effect-free formatting + id helpers shared across Kujira apps.
   Loaded by a plain <script src="kjr-format.js?v=1.2"> (exposes window.KjrFmt);
   also require()-able from tests via the module.exports shim at the foot.
   Keep this file PURE: no DOM, no localStorage, no fetch, no app globals.
   Vendored copy, do not fork. Improve the master in the template, bump the
   version, then re-vendor (see ship / housekeep drift-check).

   v1.2 changelog: reconciled a two-way drift between this master and the
   Journal vendored copy. Journal had added fmtNumber/fmtCurrency (Stage 2a,
   database block) directly to its own copy without access to this template;
   this master had independently gained the collision-resistant counter-based
   uid() (base36 time + 2-char counter + 4 random chars, safe inside a tight
   bulk-import loop) that Journal's copy still lacked. Both sides folded in,
   no functionality dropped either way.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var VERSION = '1.2';

  /* Two-digit zero pad. pad(3) -> '03'. */
  function pad(n) { return String(n).padStart(2, '0'); }

  /* Compact, sortable, collision-resistant id. Base36 time + 2-char counter + 4
     random chars. The counter makes ids minted in a tight loop (bulk import)
     unique even inside one millisecond, where time + random alone can collide. */
  var uidN = 0;
  function uid() { uidN = (uidN + 1) % 1296; return Date.now().toString(36) + (uidN + 1296).toString(36).slice(1) + Math.random().toString(36).slice(2, 6); }

  /* XSS-safe HTML escaping for &<>"'. */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Today as an ISO date (local clock). */
  function todayISO() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  /* ISO date from year, 0-based month, day (matches Date.getMonth). */
  function isoFromYMD(y, m0, d) { return y + '-' + pad(m0 + 1) + '-' + pad(d); }

  /* ISO -> DD/MM/YYYY. Non-ISO input is returned unchanged, null -> em-free dash. */
  function fmtDate(iso) {
    if (!iso) return '\u2014';
    var p = String(iso).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso;
  }

  /* ISO -> "Monday, 14 June" style long date (en-GB). Falls back to fmtDate. */
  function fmtLongDate(iso) {
    var d = new Date(iso + 'T00:00');
    if (isNaN(d)) return fmtDate(iso);
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  /* Plain number, thousands separators, no currency symbol. Non-finite/non-number
     input returns the same "no value" dash fmtDate uses above, never a rendered
     NaN or a broken string. */
  function fmtNumber(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '\u2014';
    return n.toLocaleString('en-SG', { maximumFractionDigits: 2 });
  }

  /* Currency, SGD by default (Kujira apps are Singapore-based), via Intl.NumberFormat.
     Non-finite/non-number input returns the same dash, never "$NaN". A currency code
     Intl does not recognise falls back to a plain "CODE 1,234.50" shape rather than
     throwing. */
  function fmtCurrency(n, currency) {
    if (typeof n !== 'number' || !isFinite(n)) return '\u2014';
    var cur = currency || 'SGD';
    try {
      return new Intl.NumberFormat('en-SG', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n);
    } catch (e) {
      return cur + ' ' + fmtNumber(n);
    }
  }

  var api = { VERSION: VERSION, pad: pad, uid: uid, esc: esc, escapeHtml: esc, todayISO: todayISO, isoFromYMD: isoFromYMD, fmtDate: fmtDate, fmtLongDate: fmtLongDate, fmtNumber: fmtNumber, fmtCurrency: fmtCurrency };

  root.KjrFmt = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
