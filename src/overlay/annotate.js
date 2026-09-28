/* NhakoCapture — annotation surface
 *
 * The canvas that sits over the selection, and the pointer handling that turns
 * a drag into an op.
 *
 * The canvas carries the base image as well as the marks, rather than being a
 * transparent sheet laid over the frozen backdrop. Two reasons: blur needs real
 * pixels underneath to redact, and it makes the preview and the export the same
 * pixels produced by the same code, so WYSIWYG is structural rather than a
 * thing to keep in sync.
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  if (!NC || NC.modules.annotate) return;

  const renderer = NC.require('render');

  const SIZES = { thin: 2, medium: 4, thick: 8 };

  /* Text is committed through a real input rather than keystroke capture, so
   * IME, autocorrect, selection and paste all behave normally. */
  function textEditor({ layer, at, color, size, font, onCommit, onCancel }) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'nc-textentry';
    input.style.left = `${at[0]}px`;
    input.style.top = `${at[1]}px`;
    input.style.color = color;
    input.style.fontSize = `${size}px`;
    input.style.fontFamily = font;
    input.setAttribute('aria-label', 'Annotation text');
    layer.appendChild(input);
    // Focus must wait a frame: the pointerup that created it is still settling.
    requestAnimationFrame(() => input.focus());

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.remove();
      if (commit && value) onCommit(value);
      else onCancel();
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // never let Escape here tear down the whole overlay
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    /* A press inside the box is for moving the caret. Reaching the root, it
     * would commit this label and open a new one where the user clicked. */
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    return { cancel: () => finish(false), commit: () => finish(true) };
  }

  function create({ layer, bitmap, metrics, ops, getRect, onChange, origin = { x: 0, y: 0 } }) {
    const canvas = document.createElement('canvas');
    canvas.className = 'nc-annotate';
    canvas.hidden = true;
    /* Underneath the marquee, not on top of it. Appended last, the canvas
     * painted over the frame's border and the inner half of every handle. */
    layer.insertBefore(canvas, layer.firstChild);

    /* A canvas, not a div with the capture as its CSS background. The
     * background route needed the capture's URL, and in the editor window a
     * full-page capture's blob URL is revoked the moment it has decoded -- so
     * the loupe showed nothing there. Drawing from the decoded image needs no
     * URL at all, and copies a 140px square per move instead of making the
     * browser hold and re-resolve a multi-megabyte data URL as a style. */
    const loupe = document.createElement('canvas');
    loupe.className = 'nc-loupe';
    loupe.hidden = true;
    layer.appendChild(loupe);

    let tool = null;                 // null = still framing
    let color = getComputedStyle(canvas).getPropertyValue('--nc-ink-default').trim() || '#ff3b30';
    let size = SIZES.medium;
    let drawing = null;
    let editor = null;
    /* Zoom: where the loupe is parked, or null when it follows the cursor.
     * Clicking toggles it, which is the tool's whole pointer behaviour -- see
     * the 'zoom' case in begin(). */
    let pinnedAt = null;

    /* The preview only needs the pixels the screen can show. In the page
     * overlay that is every device pixel (k = 1); in the editor window, where a
     * large capture is fitted down into the window, it is far fewer. */
    function previewResolution() {
      const k = (window.devicePixelRatio || 1) / metrics.scaleX;
      return k >= 0.98 ? 1 : k;
    }

    function paint() {
      const rect = getRect();
      /* Shown whenever there is something on it to see. It used to hide the
       * moment no tool was selected -- so pressing Escape to put the pen down
       * made every mark vanish from the screen, although they were all still
       * there and all still exported. */
      if (!rect || (!tool && !ops.length)) { canvas.hidden = true; return; }
      canvas.hidden = false;
      canvas.style.left = `${rect.x}px`;
      canvas.style.top = `${rect.y}px`;
      canvas.style.width = `${rect.w}px`;
      canvas.style.height = `${rect.h}px`;
      renderer.render(canvas, {
        bitmap, metrics, rect, ops: ops.all, resolution: previewResolution(),
      });
    }

    /* Exported image: the same render, run once more into a detached canvas so
     * the on-screen one is never resized mid-export. */
    function compose() {
      const rect = getRect();
      if (!rect) return null;
      const out = document.createElement('canvas');
      const dev = renderer.render(out, { bitmap, metrics, rect, ops: ops.all });
      return dev.w > 0 && dev.h > 0 ? out : null;
    }

    /* Stage-local CSS coordinates. See selection.js for what `origin` is. */
    const local = (e) => [e.clientX - origin.x, e.clientY - origin.y];

    const inside = ([x, y], r) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;

    function begin(e) {
      const p = local(e);
      /* A mark started outside the frame is clipped away entirely: it would
       * be an undo step the user can never see. Claimed and ignored, rather
       * than handed to selection.js, where the same press would throw away
       * the frame and every mark in it. The loupe is the exception -- looking
       * is harmless anywhere. */
      const rect = getRect();
      if (tool !== 'zoom' && rect && !inside(p, rect)) return true;
      switch (tool) {
        case 'pencil':
        case 'highlight':
          drawing = { tool, color, size: tool === 'highlight' ? size * 4 : size, points: [p] };
          if (tool === 'highlight') drawing.alpha = 0.45;
          ops.preview({ ...drawing });
          return true;
        case 'arrow':
          drawing = { tool: 'arrow', color, size, from: p, to: p };
          ops.preview({ ...drawing });
          return true;
        case 'blur':
          drawing = { tool: 'blur', origin: p, rect: { x: p[0], y: p[1], w: 0, h: 0 } };
          ops.preview({ tool: 'blur', rect: drawing.rect });
          return true;
        case 'text':
          openTextEditor(p);
          return true;
        case 'zoom':
          /* Zoom draws nothing, but it MUST claim the pointer.
           *
           * Returning false here let the event fall through to selection.js,
           * where the target is the marquee -- so clicking with the magnifier
           * silently dragged the capture frame instead. Claiming it also gives
           * the click something to mean: park the loupe, or release it. */
          pinnedAt = pinnedAt ? null : p;
          placeLoupe(pinnedAt ?? p);
          return true;
        default:
          return false;
      }
    }

    function move(e) {
      if (!drawing) return false;
      const p = local(e);
      if (drawing.tool === 'pencil' || drawing.tool === 'highlight') {
        drawing.points.push(p);
        /* The points array is shared, not copied. Copying it on every sample
         * made a long stroke quadratic -- a few thousand points meant millions
         * of element copies on the one path that runs per pointermove. Sharing
         * is safe: the preview is replaced on the next sample, and once the
         * stroke is committed `drawing` is dropped and never touched again. */
        ops.preview({ ...drawing });
      } else if (drawing.tool === 'arrow') {
        drawing.to = p;
        ops.preview({ ...drawing });
      } else if (drawing.tool === 'blur') {
        const o = drawing.origin;
        drawing.rect = {
          x: Math.min(o[0], p[0]), y: Math.min(o[1], p[1]),
          w: Math.abs(p[0] - o[0]), h: Math.abs(p[1] - o[1]),
        };
        ops.preview({ tool: 'blur', rect: drawing.rect });
      }
      return true;
    }

    function end() {
      /* Zoom claimed the pointerdown without starting a drawing, so it has to
       * claim the pointerup too -- otherwise the release falls through to
       * selection.js and the caller never releases the pointer capture it
       * took. */
      if (tool === 'zoom') return true;
      if (!drawing) return false;
      /* Marks too small to see are dropped rather than committed: each would
       * be an undo step that visibly does nothing. A pencil tap is kept -- it
       * paints a dot -- but a highlighter tap paints nothing, and neither
       * does an arrow with no length. */
      const d = drawing;
      const tooSmall =
        (d.tool === 'blur' && (d.rect.w < 6 || d.rect.h < 6)) ||
        (d.tool === 'highlight' && d.points.length < 2) ||
        (d.tool === 'arrow' && Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]) < 3);
      drawing = null;
      if (tooSmall) ops.dropPreview();
      else ops.commitPreview();
      return true;
    }

    function openTextEditor(at) {
      /* Committed, not cancelled. Clicking somewhere else to place the next
       * label is how people finish the current one; cancelling here threw
       * away text they had typed and never told them. */
      editor?.commit();
      const font = getComputedStyle(canvas).getPropertyValue('--nc-font').trim();
      editor = textEditor({
        layer, at, color, size: size * 4, font,
        onCommit: (text) => {
          editor = null;
          ops.add({ tool: 'text', at, text, color, size: size * 4, font });
        },
        onCancel: () => { editor = null; },
      });
    }

    const LOUPE_ZOOM = 3;
    let loupeDiameter = 0;
    let loupeCtx = null;

    /* Sized once, when zoom is chosen: getComputedStyle forces a style
     * recalculation, and the loupe's size is fixed in CSS. */
    function armLoupe() {
      loupe.hidden = false;
      loupeDiameter = parseFloat(getComputedStyle(loupe).width) || 140;
      const dpr = window.devicePixelRatio || 1;
      loupe.width = Math.round(loupeDiameter * dpr);
      loupe.height = Math.round(loupeDiameter * dpr);
      loupeCtx = loupe.getContext('2d');
      loupeCtx.imageSmoothingEnabled = false;   // pixels, not a smear
    }

    function placeLoupe([lx, ly]) {
      if (!getRect() || !loupeCtx) { loupe.hidden = true; return; }
      loupe.hidden = false;
      loupe.style.left = `${lx}px`;
      loupe.style.top = `${ly}px`;

      /* The square of the capture under the cursor, in bitmap pixels, that
       * fills the loupe at LOUPE_ZOOM. Out-of-bounds parts of the source are
       * clipped by drawImage, and the dark fill shows through there. */
      const span = loupeDiameter / LOUPE_ZOOM;
      const sw = span * metrics.scaleX, sh = span * metrics.scaleY;
      const sx = lx * metrics.scaleX - sw / 2, sy = ly * metrics.scaleY - sh / 2;
      loupeCtx.fillStyle = '#161616';
      loupeCtx.fillRect(0, 0, loupe.width, loupe.height);
      loupeCtx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, loupe.width, loupe.height);
    }

    function moveLoupe(e) {
      // Every other tool -- and no tool at all -- pays nothing for this.
      if (tool !== 'zoom' || pinnedAt) return;
      placeLoupe(local(e));
    }

    return {
      get tool() { return tool; },
      setTool(next) {
        // Switching tools finishes the label in progress rather than losing it.
        editor?.commit();
        tool = next;
        pinnedAt = null;
        if (next === 'zoom') armLoupe();
        /* Hidden until the pointer gives it somewhere to be: shown on arming,
         * it would sit at the last position it had, or at 0,0. */
        loupe.hidden = true;
        paint();
        onChange?.();
      },
      get color() { return color; },
      setColor(next) { color = next; onChange?.(); },
      get size() { return size; },
      setSize(next) { size = next; onChange?.(); },
      SIZES,

      onPointerDown: begin,
      onPointerMove: (e) => { moveLoupe(e); return move(e); },
      onPointerUp: end,

      paint,
      compose,
      get editing() { return editor !== null; },
    };
  }

  NC.define('annotate', { create, SIZES });
})();
