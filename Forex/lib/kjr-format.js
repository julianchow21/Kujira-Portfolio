/* ═══════════════════════════════════════════════════════════════════════
   KUJIRA SHARED — kjr-format.js   (KJR_FORMAT_VERSION 1.0)
   Pure, side-effect-free formatting + id helpers shared across Kujira apps.
   Loaded by a plain <script src="kjr-format.js?v=1.0"> (exposes window.KjrFmt);
   also require()-able from tests via the module.exports shim at the foot.
   Keep this file PURE: no DOM, no localStorage, no fetch, no app globals.
   Vendored copy — do not fork. Improve the master in the template, bump the
   version, then re-vendor (see ship / housekeep drift-check).
   ═══════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var VERSION = '1.0';

  /* Two-digit zero pad. pad(3) -> '03'. */
  function pad(n) { return String(n).padStart(2, '0'); }

  /* Compact, sortable, collision-resistant id. Base36 time + 5 random chars. */
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

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
    if (!iso) return '—';
    var p = String(iso).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso;
  }

  /* ISO -> "Monday, 14 June" style long date (en-GB). Falls back to fmtDate. */
  function fmtLongDate(iso) {
    var d = new Date(iso + 'T00:00');
    if (isNaN(d)) return fmtDate(iso);
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  var api = { VERSION: VERSION, pad: pad, uid: uid, esc: esc, escapeHtml: esc, todayISO: todayISO, isoFromYMD: isoFromYMD, fmtDate: fmtDate, fmtLongDate: fmtLongDate };

  root.KjrFmt = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
