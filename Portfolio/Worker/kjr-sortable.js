/* ═══════════════════════════════════════════════════════════════════════
   KUJIRA SHARED, kjr-sortable.js   (KJR_SORTABLE_VERSION 1.5)
   Reusable pointer-events drag-to-reorder engine. App-agnostic.
   Loaded by a plain <script src="kjr-sortable.js?v=1.5"> (exposes
   window.KjrSortable); also require()-able from node for unit tests.

   v1.2 changelog: pointerdown no longer preventDefault()s unconditionally
   (that suppressed every real click's synthesised mousedown/up/click per
   the pointer-events spec), a drag now only arms past a 6px move
   threshold, and the one trailing click after a real drag is swallowed via
   a capture-phase listener, real mouse/touch clicks on a handle work again.

   v1.3 changelog: justDragged now resets on every pointerdown, not only
   when its one trailing click actually arrives, so a drag whose click never
   synthesised (eg pointerup landing outside the original target) can no
   longer eat an unrelated LATER tap. pointercancel now genuinely cancels:
   it restores the item to its exact pre-drag DOM position (not wherever the
   placeholder happened to be at the moment of cancellation) and only calls
   onReorder if the resulting order actually differs from the pre-drag order.

   v1.4 changelog: disable() called mid-drag used to call _commit(), which
   could fire onReorder with whatever half-finished order the placeholder
   happened to be sitting at the instant disable() ran. It now calls
   _cancel() instead, the same restore-to-pre-drag-position path pointercancel
   uses, so disabling mid-drag behaves like an aborted gesture, not a drop.

   v1.5 changelog: a drag no longer strands if pointerup/pointercancel never
   reaches captureEl (setPointerCapture failed or was silently lost, or an
   app-level re-render detached captureEl from the DOM mid-drag). Window-
   level pointerup/pointercancel/blur fallback listeners are attached for
   the duration of an active drag only (removed on commit and cancel) and
   drive the same _commit()/_cancel() paths. Every pointermove now checks
   captureEl and dragItem isConnected and cancels immediately if either has
   left the document, catching a detach that happens between events. Because
   the fallback can fire after containerEl has been rewired out from under
   an in-progress drag, _commit()/_cancel() no longer assume the placeholder
   (or _cancel's recorded original sibling) is still attached to containerEl,
   both degrade to a safe cleanup instead of risking an uncaught NotFoundError
   from insertBefore against a stale reference node. create()/enable()/
   destroy() now also sweep containerEl for stray .kjr-sortable-placeholder
   nodes, eg one left behind by a prior instance whose closure was discarded
   (destroyed element, re-render) without a clean destroy() ever running.

   CSS contract (host provides these classes):
     .kjr-sortable-dragging     : applied to the lifted item
     .kjr-sortable-placeholder  : the gap left behind
     .kjr-sortable-active       : applied to the container during a drag

   Handle CSS must include:  touch-action: none;
   Without it touch-drag scrolls the page instead of reordering.

   Keep this file PURE: no DOM ids, no app globals, no app-specific strings.
   Vendored copy, do not fork. Improve the master in the template, bump
   the version, then re-vendor (see /ship / /housekeep drift-check).
   ═══════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var VERSION = '1.5';

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
       itemSelector   {string}   REQUIRED: which direct children are items
       handleSelector {string}   optional: drag starts on this child only
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
    var dragOriginalNextSibling = null; /* dragItem's next-sibling BEFORE the drag started, restores exact position on pointercancel */
    var dragOriginalOrder = null;       /* getOrder() snapshot BEFORE the drag started, so a cancel can tell "did the order actually change" */

    /* click-suppression state (v1.2) */
    var candidate   = null;  /* pre-threshold pointerdown: {pointerId, item, handle, startX, startY} */
    var justDragged = false; /* true for exactly one click following a real drag, consumed by _onClickCapture */
    var DRAG_PX     = 6;     /* px of movement before a candidate is promoted to a real drag */

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

    /* ── stray placeholder sweep (v1.5) ──────────────────────────────────
       Removes any .kjr-sortable-placeholder direct child of containerEl
       that ISN'T this instance's own live placeholder. Covers a prior
       instance (eg from an app-level destroy-and-recreate re-render) whose
       closure was discarded mid-drag without destroy() ever running, its
       placeholder is orphaned DOM with nothing left to clean it up except
       whichever instance looks at this container next. Run at init, and
       again on every enable()/destroy() so re-enabling after an app
       re-render also clears anything left over. */
    function _sweepStrayPlaceholders() {
      var strays = containerEl.querySelectorAll(':scope > .kjr-sortable-placeholder');
      for (var i = 0; i < strays.length; i++) {
        if (strays[i] !== placeholder && strays[i].parentElement) {
          strays[i].parentElement.removeChild(strays[i]);
        }
      }
    }

    /* ── event handlers ──────────────────────────────────────────────────
       Two-phase: a pointerdown on a valid handle/item only ever records a
       CANDIDATE (no preventDefault, no DOM change) and arms move/up/cancel
       listeners on document. Only once movement exceeds DRAG_PX does
       _startDrag() promote the candidate into a real drag (lift, placeholder,
       pointer capture, preventDefault from then on). A clean tap never
       crosses the threshold, so its native mousedown/mouseup/click fire
       exactly as the browser would for any other element (see v1.2 changelog
       above: the old unconditional preventDefault on pointerdown is what
       broke this). */
    function _onPointerDown(e) {
      /* a new interaction is starting: clear any stale swallow-flag left over from a
         PREVIOUS drag whose one trailing click never actually synthesised (eg its
         pointerup landed outside the original target), which would otherwise eat this
         new, entirely unrelated tap. */
      justDragged = false;
      if (!enabled) return;
      if (activeId !== null || candidate !== null) return; /* ignore second pointer */

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

      candidate = { pointerId: e.pointerId, item: item, handle: handle, startX: e.clientX, startY: e.clientY };
      document.addEventListener('pointermove',   _onCandidateMove);
      document.addEventListener('pointerup',     _onCandidateUp);
      document.addEventListener('pointercancel', _onCandidateCancel);
    }

    function _clearCandidate() {
      document.removeEventListener('pointermove',   _onCandidateMove);
      document.removeEventListener('pointerup',     _onCandidateUp);
      document.removeEventListener('pointercancel', _onCandidateCancel);
      candidate = null;
    }

    function _onCandidateMove(e) {
      if (!candidate || e.pointerId !== candidate.pointerId) return;
      var dx = e.clientX - candidate.startX;
      var dy = e.clientY - candidate.startY;
      if ((dx * dx + dy * dy) < (DRAG_PX * DRAG_PX)) return; /* still just a tap-in-progress */
      _startDrag(e);
    }
    function _onCandidateUp(e) {
      if (!candidate || e.pointerId !== candidate.pointerId) return;
      _clearCandidate(); /* released before the threshold: a clean tap, its native click fires untouched */
    }
    function _onCandidateCancel(e) {
      if (!candidate || e.pointerId !== candidate.pointerId) return;
      _clearCandidate();
    }

    /* promote a candidate into a real drag: from here on this pointer
       session behaves exactly as the pre-v1.2 engine always did (lift,
       placeholder, capture), except preventDefault is now scoped to the
       drag gesture itself, never to the original pointerdown/click. */
    function _startDrag(e) {
      var item = candidate.item, handle = candidate.handle;
      _clearCandidate();

      e.preventDefault(); /* suppress text-selection/scroll now that this IS a real drag */

      activeId = e.pointerId;
      dragItem = item;
      dragOriginalNextSibling = item.nextSibling; /* captured BEFORE any DOM change below, restores exact position on pointercancel */
      dragOriginalOrder = getOrder();
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
      try { captureEl.setPointerCapture(activeId); } catch (_) {}
      captureEl.addEventListener('pointermove',   _onPointerMove);
      captureEl.addEventListener('pointerup',     _onPointerUp);
      captureEl.addEventListener('pointercancel', _onPointerCancel);
      _addWindowFallbackListeners();

      _onPointerMove(e); /* land the lifted item at the pointer's CURRENT position immediately */
    }

    /* ── window-level fallback (v1.5) ─────────────────────────────────────
       captureEl's own pointerup/pointercancel only fire if the event still
       reaches captureEl, which fails silently if setPointerCapture() never
       took (the try/catch above), or if an app-level re-render detaches
       captureEl from the DOM mid-drag (a detached element can no longer be
       hit-tested or receive retargeted captured events). These three
       window listeners are attached only while a drag is active (added in
       _startDrag, removed in _teardownDragVisuals) and back-stop exactly
       that: pointerup still commits at the last placeholder position,
       pointercancel and blur (eg alt-tab, devtools focus-steal) cancel
       cleanly. Both handlers also fire naturally after captureEl's own
       listener on a normal drop (pointer capture events still bubble to
       window), which is harmless: _commit()/_cancel() are no-ops once
       dragItem/placeholder are already cleared. */
    function _addWindowFallbackListeners() {
      window.addEventListener('pointerup',     _onWindowPointerUp);
      window.addEventListener('pointercancel', _onWindowPointerCancel);
      window.addEventListener('blur',          _onWindowBlur);
    }
    function _removeWindowFallbackListeners() {
      window.removeEventListener('pointerup',     _onWindowPointerUp);
      window.removeEventListener('pointercancel', _onWindowPointerCancel);
      window.removeEventListener('blur',          _onWindowBlur);
    }
    function _onWindowPointerUp(e) {
      if (e.pointerId !== activeId || !dragItem) return;
      justDragged = true;
      _commit();
    }
    function _onWindowPointerCancel(e) {
      if (e.pointerId !== activeId || !dragItem) return;
      _cancel();
    }
    function _onWindowBlur() {
      if (activeId !== null) _cancel(); /* window lost focus mid-drag: never sure the pointer is still "down", cancel rather than guess a commit */
    }

    function _onPointerMove(e) {
      if (e.pointerId !== activeId || !dragItem) return;
      /* captureEl or dragItem left the document (app re-render mid-drag):
         no valid capture target left to keep tracking, cancel now rather
         than risk operating on stale/detached nodes on the next event. */
      if (!captureEl || !captureEl.isConnected || !dragItem.isConnected) { _cancel(); return; }
      dragItem.style.top = (e.clientY - grabDy) + 'px';
      _movePlaceholder(e.clientY);
      if (edgePx) _scrollStep(e.clientY);
    }

    /* shared cleanup for both a real drop (_commit) and an aborted gesture (_cancel):
       strips the lifted-item styles/classes and releases pointer capture + the per-
       drag listeners. Does NOT touch the placeholder or dragItem's DOM position, the
       two callers below differ on exactly that (commit-in-place vs restore-original). */
    function _teardownDragVisuals() {
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
      _removeWindowFallbackListeners();
    }

    function _commit() {
      if (!dragItem || !placeholder) return;
      _stopScroll();

      /* v1.5: only reposition via the placeholder if it's still actually a
         live child of containerEl. An app-level re-render can rewire
         containerEl's children out from under an in-progress drag (see the
         window-fallback comment above), and insertBefore() against a
         reference node that is no longer containerEl's child throws
         NotFoundError, aborting this function BEFORE the cleanup below runs,
         which is exactly how a drag used to get stuck: dashed placeholder
         left in the DOM, listeners never removed. Skipping the reposition
         in that case still lets everything below run to completion. */
      if (placeholder.parentElement === containerEl) {
        containerEl.insertBefore(dragItem, placeholder);
      }
      placeholder.parentElement && placeholder.parentElement.removeChild(placeholder);
      placeholder = null;

      _teardownDragVisuals();

      var order = getOrder();
      dragItem   = null;
      activeId   = null;
      dragOriginalNextSibling = null;
      dragOriginalOrder = null;

      if (onReorder) onReorder(order);
    }

    /* pointercancel semantics (v1.3): the gesture was ABORTED, not completed (per the
       Pointer Events spec, eg the browser handed the pointer to native scroll/zoom, or
       an OS-level interruption), so this restores dragItem to its EXACT pre-drag DOM
       position (dragOriginalNextSibling, captured in _startDrag) rather than committing
       wherever the placeholder happened to be at the moment of cancellation, and only
       calls onReorder if the resulting order actually differs from the order captured
       right before the drag started (dragOriginalOrder): restoring correctly should
       always leave it unchanged, this is a belt-and-braces equality check, not an
       assumption that it always holds. */
    function _cancel() {
      if (!dragItem || !placeholder) return;
      _stopScroll();

      /* v1.5: same guard as _commit() above, applied to the restore target
         this time. dragOriginalNextSibling may itself have been removed or
         reparented by an app-level re-render mid-drag, insertBefore() would
         throw NotFoundError against a reference node no longer in
         containerEl. null degrades to "append at the end", same as the
         pre-existing behaviour when the dragged item was originally last. */
      if (dragOriginalNextSibling && dragOriginalNextSibling.parentElement !== containerEl) {
        dragOriginalNextSibling = null;
      }
      containerEl.insertBefore(dragItem, dragOriginalNextSibling);
      placeholder.parentElement && placeholder.parentElement.removeChild(placeholder);
      placeholder = null;

      _teardownDragVisuals();

      var order = getOrder();
      var before = dragOriginalOrder;
      var changed = !before || order.length !== before.length || order.some(function (id, i) { return id !== before[i]; });
      dragItem   = null;
      activeId   = null;
      dragOriginalNextSibling = null;
      dragOriginalOrder = null;

      if (onReorder && changed) onReorder(order);
    }

    function _onPointerUp(e) {
      if (e.pointerId !== activeId) return;
      justDragged = true; /* a real drag completed: swallow the one trailing click, see _onClickCapture */
      _commit();
    }

    function _onPointerCancel(e) {
      if (e.pointerId !== activeId) return;
      _cancel(); /* gesture aborted, not completed: restore original order, see _cancel above */
    }

    /* capture-phase, fires before ANY bubble-phase click handler anywhere in
       containerEl's subtree (app row-click, row-menu, etc): after a real
       drag the browser still synthesises one native click following the
       pointerup (mousedown/mouseup were never cancelled, only the drag
       gesture's own defaults were), and that click must not re-trigger the
       item's own click behaviour (navigate/open/toggle). A plain tap never
       sets justDragged, so it always falls through untouched. */
    function _onClickCapture(e) {
      if (!justDragged) return;
      justDragged = false;
      e.preventDefault();
      e.stopPropagation();
    }

    /* attach delegated listeners */
    containerEl.addEventListener('pointerdown', _onPointerDown);
    containerEl.addEventListener('click', _onClickCapture, true);

    /* ── public instance API ── */
    function enable()     { enabled = true; _sweepStrayPlaceholders(); }
    function disable()    {
      enabled = false;
      if (candidate !== null) _clearCandidate();
      if (activeId !== null) _cancel(); /* abort in-progress drag: restore pre-drag position, never commit a half-finished order */
    }
    function isEnabled()  { return enabled; }
    function isDragging() { return activeId !== null; }
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
      disable(); /* also removes this instance's own window fallback listeners + captureEl listeners if a drag was active, see _cancel -> _teardownDragVisuals */
      _sweepStrayPlaceholders(); /* this instance's own placeholder is already gone via disable()->_cancel(); this also clears anything orphaned by an EARLIER instance on the same container */
      containerEl.removeEventListener('pointerdown', _onPointerDown);
      containerEl.removeEventListener('click', _onClickCapture, true);
    }

    _sweepStrayPlaceholders(); /* v1.5: clear anything orphaned by a prior instance on this same container before this one starts using it */

    return { enable: enable, disable: disable, isEnabled: isEnabled, isDragging: isDragging, getOrder: getOrder, destroy: destroy };
  }

  /* ── exports ── */
  var api = { VERSION: VERSION, create: create, indexForPointer: indexForPointer };

  root.KjrSortable = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
