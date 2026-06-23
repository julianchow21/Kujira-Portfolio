/* ═══════════════════════════════════════════════════════════════════════
   KUJIRA SHARED — kjr-sortable.js   (KJR_SORTABLE_VERSION 1.0)
   Reusable pointer-events drag-to-reorder engine. App-agnostic.
   Loaded by a plain <script src="kjr-sortable.js?v=1.0"> (exposes
   window.KjrSortable); also require()-able from node for unit tests.

   CSS contract (host provides these classes):
     .kjr-sortable-dragging     — applied to the lifted item
     .kjr-sortable-placeholder  — the gap left behind
     .kjr-sortable-active       — applied to the container during a drag

   Handle CSS must include:  touch-action: none;
   Without it touch-drag scrolls the page instead of reordering.

   Keep this file PURE: no DOM ids, no app globals, no app-specific strings.
   Vendored copy — do not fork. Improve the master in the template, bump
   the version, then re-vendor (see /ship / /housekeep drift-check).
   ═══════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var VERSION = '1.0';

  /* ── Pure helper ─────────────────────────────────────────────────────
     indexForPointer(pointerY, itemRects) -> insertion index (0..n)
     itemRects: array of {top, height} for candidate siblings (excluding
     the dragged item and the placeholder). Returns where to insert
     before relative to the pointer's Y position (midpoint threshold). */
  function indexForPointer(pointerY, itemRects) {
    if (!itemRects || itemRects.length === 0) return 0;
    for (var i = 0; i < itemRects.length; i++) {
      var r = itemRects[i];
      var mid = r.top + r.height / 2;
      if (pointerY < mid) return i;
    }
    return itemRects.length;
  }

  /* ── create(containerEl, opts) -> instance ───────────────────────────
     opts:
       itemSelector   {string}   REQUIRED — which direct children are items
       handleSelector {string}   optional — drag starts on this child only
       idAttr         {string}   attribute to read for order ids (default 'data-wid')
       onReorder      {function} called once on drop with array of ids
       scrollEdgePx   {number}   auto-scroll zone height in px (default 56; 0 disables)
       enabled        {bool}     start enabled (default false)                       */
  function create(containerEl, opts) {
    if (!containerEl) return null;
    opts = opts || {};

    var itemSel    = opts.itemSelector || '[data-wid]';
    var handleSel  = opts.handleSelector || null;
    var idAttr     = opts.idAttr || 'data-wid';
    var onReorder  = typeof opts.onReorder === 'function' ? opts.onReorder : null;
    var edgePx     = opts.scrollEdgePx != null ? opts.scrollEdgePx : 56;
    var enabled    = !!opts.enabled;

    /* drag state */
    var activeId   = null;   /* pointerId currently dragging */
    var dragItem   = null;
    var placeholder = null;
    var grabDy     = 0;
    var rafId      = null;
    var captureEl  = null;

    /* ── auto-scroll ── */
    function _scrollStep(clientY) {
      if (rafId) cancelAnimationFrame(rafId);
      if (!edgePx || !dragItem) return;
      var step = 0;
      if (clientY < edgePx) step = -Math.max(6, edgePx - clientY);
      else if (clientY > window.innerHeight - edgePx) step = Math.max(6, clientY - (window.innerHeight - edgePx));
      if (!step) return;
      rafId = requestAnimationFrame(function () {
        window.scrollBy(0, step);
        _scrollStep(clientY);
      });
    }

    function _stopScroll() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    }

    /* ── build itemRects for siblings excluding dragItem + placeholder ── */
    function _siblingRects() {
      var rects = [];
      var children = containerEl.querySelectorAll(':scope > ' + itemSel);
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c === dragItem || c === placeholder) continue;
        var r = c.getBoundingClientRect();
        rects.push({ top: r.top, height: r.height, el: c });
      }
      return rects;
    }

    /* ── move placeholder to correct slot ── */
    function _movePlaceholder(clientY) {
      var rects = _siblingRects();
      var idx = indexForPointer(clientY, rects);
      if (idx >= rects.length) {
        containerEl.appendChild(placeholder);
      } else {
        containerEl.insertBefore(placeholder, rects[idx].el);
      }
    }

    /* ── event handlers ── */
    function _onPointerDown(e) {
      if (!enabled) return;
      if (activeId !== null) return; /* ignore second pointer */

      var handle = handleSel ? e.target.closest(handleSel) : null;
      /* if no handleSelector, the whole item is the handle */
      var item;
      if (handleSel) {
        if (!handle) return;
        item = handle.closest(itemSel);
      } else {
        item = e.target.closest(itemSel);
      }
      if (!item) return;
      /* must be a direct child */
      if (item.parentElement !== containerEl) return;

      e.preventDefault();

      activeId = e.pointerId;
      dragItem = item;
      var rect = item.getBoundingClientRect();
      grabDy = e.clientY - rect.top;

      /* placeholder */
      var cs = window.getComputedStyle(item);
      placeholder = document.createElement('div');
      placeholder.className = 'kjr-sortable-placeholder';
      placeholder.style.height = rect.height + 'px';
      placeholder.style.width = '100%';
      placeholder.style.marginTop = cs.marginTop;
      placeholder.style.marginBottom = cs.marginBottom;
      placeholder.style.boxSizing = 'border-box';
      containerEl.insertBefore(placeholder, item);

      /* lift item */
      item.style.position  = 'fixed';
      item.style.left      = rect.left + 'px';
      item.style.width     = rect.width + 'px';
      item.style.top       = rect.top + 'px';
      item.style.margin    = '0';
      item.style.zIndex    = '9999';
      item.style.pointerEvents = 'none';
      item.classList.add('kjr-sortable-dragging');
      containerEl.classList.add('kjr-sortable-active');

      captureEl = handleSel ? handle : item;
      captureEl.setPointerCapture(activeId);
      captureEl.addEventListener('pointermove',   _onPointerMove);
      captureEl.addEventListener('pointerup',     _onPointerUp);
      captureEl.addEventListener('pointercancel', _onPointerCancel);
    }

    function _onPointerMove(e) {
      if (e.pointerId !== activeId || !dragItem) return;
      dragItem.style.top = (e.clientY - grabDy) + 'px';
      _movePlaceholder(e.clientY);
      if (edgePx) _scrollStep(e.clientY);
    }

    function _commit() {
      if (!dragItem || !placeholder) return;
      _stopScroll();

      containerEl.insertBefore(dragItem, placeholder);
      placeholder.parentElement && placeholder.parentElement.removeChild(placeholder);
      placeholder = null;

      /* strip lifted styles */
      dragItem.style.position     = '';
      dragItem.style.left         = '';
      dragItem.style.width        = '';
      dragItem.style.top          = '';
      dragItem.style.margin       = '';
      dragItem.style.zIndex       = '';
      dragItem.style.pointerEvents = '';
      dragItem.classList.remove('kjr-sortable-dragging');
      containerEl.classList.remove('kjr-sortable-active');

      if (captureEl) {
        try { captureEl.releasePointerCapture(activeId); } catch (_) {}
        captureEl.removeEventListener('pointermove',   _onPointerMove);
        captureEl.removeEventListener('pointerup',     _onPointerUp);
        captureEl.removeEventListener('pointercancel', _onPointerCancel);
        captureEl = null;
      }

      var order = getOrder();
      dragItem   = null;
      activeId   = null;

      if (onReorder) onReorder(order);
    }

    function _onPointerUp(e) {
      if (e.pointerId !== activeId) return;
      _commit();
    }

    function _onPointerCancel(e) {
      if (e.pointerId !== activeId) return;
      _commit(); /* clean up even on cancel; no reorder callback on cancel */
    }

    /* attach delegated listener */
    containerEl.addEventListener('pointerdown', _onPointerDown);

    /* ── public instance API ── */
    function enable()     { enabled = true; }
    function disable()    {
      enabled = false;
      if (activeId !== null) _commit(); /* cancel in-progress drag */
    }
    function isEnabled()  { return enabled; }
    function getOrder()   {
      var ids = [];
      var children = containerEl.querySelectorAll(':scope > ' + itemSel);
      for (var i = 0; i < children.length; i++) {
        var id = children[i].getAttribute(idAttr);
        if (id) ids.push(id);
      }
      return ids;
    }
    function destroy()    {
      disable();
      containerEl.removeEventListener('pointerdown', _onPointerDown);
    }

    return { enable: enable, disable: disable, isEnabled: isEnabled, getOrder: getOrder, destroy: destroy };
  }

  /* ── exports ── */
  var api = { VERSION: VERSION, create: create, indexForPointer: indexForPointer };

  root.KjrSortable = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
