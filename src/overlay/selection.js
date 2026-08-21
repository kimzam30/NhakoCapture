/* NhakoCapture — selection
 *
 * Drawing, moving and resizing the capture frame, plus the live dimension badge.
 *
 * Pointer Events throughout, not mouse events. setPointerCapture keeps a drag
 * alive when the cursor leaves the window, which is the difference between
 * releasing outside the viewport committing your selection and silently losing
 * it. v1 used mouse events and lost the drag.
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  if (!NC || NC.modules.selection) return;

  const geometry = NC.require('geometry');

  const DIRECTIONS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const NUDGE = 1;
  const NUDGE_FAST = 10;

  /* `origin` is the stage's top-left in viewport CSS pixels. It is {0,0} for the
   * in-page overlay, which fills the viewport, and the letterbox offset in the
   * fallback editor window, where the image is fitted inside a larger window.
   * Only absolute positions need it -- moves and resizes work off deltas. */
  function create({ layer, view, metrics, setHole, onChange, origin = { x: 0, y: 0 } }) {
    const marquee = document.createElement('div');
    marquee.className = 'nc-marquee';
    marquee.hidden = true;
    layer.appendChild(marquee);

    const handles = {};
    for (const dir of DIRECTIONS) {
      const h = document.createElement('div');
      h.className = 'nc-handle';
      h.dataset.dir = dir;
      marquee.appendChild(h);
      handles[dir] = h;
    }

    const badge = document.createElement('div');
    badge.className = 'nc-badge';
    badge.hidden = true;
    /* Announced politely so a screen-reader user gets the size without the
     * digits chattering on every pointermove. */
    badge.setAttribute('aria-live', 'polite');
    badge.setAttribute('role', 'status');
    layer.appendChild(badge);

    let rect = null;      // CSS px, viewport-relative
    let mode = 'idle';    // idle | drawing | adjusting
    let drag = null;

    const clamp = (r) => geometry.clampToViewport(r, view.width, view.height);

    function emit() {
      onChange?.(rect, mode);
    }

    function paint() {
      if (!rect || rect.w <= 0 || rect.h <= 0) {
        marquee.hidden = true;
        badge.hidden = true;
        setHole(null);
        return;
      }
      marquee.hidden = false;
      marquee.style.left = `${rect.x}px`;
      marquee.style.top = `${rect.y}px`;
      marquee.style.width = `${rect.w}px`;
      marquee.style.height = `${rect.h}px`;

      const half = 'calc(var(--nc-handle-size) / -2)';
      const place = (dir, left, top) => {
        const h = handles[dir];
        h.style.left = left;
        h.style.top = top;
      };
      const midX = `calc(50% + ${half})`;
      const midY = `calc(50% + ${half})`;
      place('nw', half, half);
      place('n', midX, half);
      place('ne', `calc(100% + ${half})`, half);
      place('e', `calc(100% + ${half})`, midY);
      place('se', `calc(100% + ${half})`, `calc(100% + ${half})`);
      place('s', midX, `calc(100% + ${half})`);
      place('sw', half, `calc(100% + ${half})`);
      place('w', half, midY);

      paintBadge();
      setHole(rect);
    }

    function paintBadge() {
      /* Device pixels, not CSS pixels. This is the size of the file you will
       * get: framing 800x600 on a 2x display produces a 1600x1200 PNG, and
       * showing the CSS number would quietly mislead. */
      const dev = geometry.toDevice(rect, metrics);
      badge.textContent = `${dev.w} × ${dev.h}`;
      badge.hidden = false;

      /* Above the selection by default; tucked inside when it would clip off
       * the top of the viewport. */
      const GAP = 6;
      const above = rect.y - GAP;
      const height = badge.offsetHeight || 20;
      const top = above - height >= 0 ? above - height : rect.y + GAP;
      badge.style.left = `${Math.min(rect.x, Math.max(0, view.width - (badge.offsetWidth || 60)))}px`;
      badge.style.top = `${Math.max(0, top)}px`;
    }

    /* --- drawing a new frame --------------------------------------------- */
    const at = (e) => ({ x: e.clientX - origin.x, y: e.clientY - origin.y });

    function beginDraw(event) {
      mode = 'drawing';
      const from = at(event);
      drag = {
        pointerId: event.pointerId,
        update: (e) => {
          const to = at(e);
          rect = clamp(geometry.normalizeDrag(from.x, from.y, to.x, to.y));
          paint();
          emit();
        },
        finish: () => {
          if (!rect || !geometry.isMeaningfulDrag(rect)) {
            // Too small to be intentional. Treat as a misclick, not a selection.
            rect = null;
            mode = 'idle';
            paint();
          } else {
            mode = 'adjusting';
          }
          emit();
        },
      };
      drag.update(event);
    }

    /* --- moving an existing frame ----------------------------------------- */
    function beginMove(event) {
      const start = { ...rect };
      const from = { x: event.clientX, y: event.clientY };
      drag = {
        pointerId: event.pointerId,
        update: (e) => {
          const dx = e.clientX - from.x;
          const dy = e.clientY - from.y;
          rect = {
            /* Clamp the origin so the frame slides along the edge instead of
             * shrinking when you push it past the viewport. */
            x: Math.max(0, Math.min(start.x + dx, view.width - start.w)),
            y: Math.max(0, Math.min(start.y + dy, view.height - start.h)),
            w: start.w,
            h: start.h,
          };
          paint();
          emit();
        },
        finish: () => emit(),
      };
    }

    /* --- resizing from a handle -------------------------------------------- */
    function beginResize(event, dir) {
      const start = { ...rect };
      const from = { x: event.clientX, y: event.clientY };
      drag = {
        pointerId: event.pointerId,
        update: (e) => {
          const dx = e.clientX - from.x;
          const dy = e.clientY - from.y;
          let { x, y, w, h } = start;

          if (dir.includes('w')) { x = start.x + dx; w = start.w - dx; }
          if (dir.includes('e')) { w = start.w + dx; }
          if (dir.includes('n')) { y = start.y + dy; h = start.h - dy; }
          if (dir.includes('s')) { h = start.h + dy; }

          /* Dragging a handle past its opposite edge flips the frame rather
           * than clamping it to zero -- the same behaviour every image editor
           * has, and normalizeDrag already expresses it. */
          rect = clamp(geometry.normalizeDrag(x, y, x + w, y + h));
          paint();
          emit();
        },
        finish: () => emit(),
      };
    }

    /* --- pointer plumbing --------------------------------------------------- */
    function onPointerDown(event) {
      if (event.button !== 0) return;
      const target = event.composedPath()[0];

      // The pill and anything else interactive opts out by its own handler.
      if (target?.closest?.('.nc-pill')) return;

      event.preventDefault();

      if (target?.classList?.contains('nc-handle')) {
        beginResize(event, target.dataset.dir);
      } else if (target === marquee && rect) {
        beginMove(event);
      } else {
        beginDraw(event);
      }

      if (drag) {
        // Capture on the root: the drag survives leaving the window.
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    }

    function onPointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      drag.update(event);
    }

    function onPointerUp(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const finish = drag.finish;
      drag = null;
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
      finish();
    }

    /* --- keyboard ----------------------------------------------------------- */
    function onKeyDown(event) {
      if (!rect || mode !== 'adjusting') return false;

      const step = event.shiftKey ? NUDGE_FAST : NUDGE;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (!delta) return false;

      const [dx, dy] = delta;
      if (event.altKey) {
        // Alt resizes from the bottom-right instead of moving.
        rect = clamp({ x: rect.x, y: rect.y, w: Math.max(1, rect.w + dx), h: Math.max(1, rect.h + dy) });
      } else {
        rect = {
          x: Math.max(0, Math.min(rect.x + dx, view.width - rect.w)),
          y: Math.max(0, Math.min(rect.y + dy, view.height - rect.h)),
          w: rect.w,
          h: rect.h,
        };
      }
      paint();
      emit();
      return true;
    }

    function set(next) {
      rect = next ? clamp(next) : null;
      mode = rect ? 'adjusting' : 'idle';
      paint();
      emit();
    }

    function clear() { set(null); }

    return {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onKeyDown,
      set,
      clear,
      selectAll: () => set({ x: 0, y: 0, w: view.width, h: view.height }),
      get rect() { return rect; },
      get mode() { return mode; },
      get dragging() { return drag !== null; },
    };
  }

  NC.define('selection', { create, DIRECTIONS });
})();
