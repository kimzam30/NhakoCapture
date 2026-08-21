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
    return { cancel: () => finish(false) };
  }

  function create({ layer, bitmap, metrics, ops, getRect, onChange, origin = { x: 0, y: 0 } }) {
    const canvas = document.createElement('canvas');
    canvas.className = 'nc-annotate';
    canvas.hidden = true;
    layer.appendChild(canvas);

    const loupe = document.createElement('div');
    loupe.className = 'nc-loupe';
    loupe.hidden = true;
    layer.appendChild(loupe);

    let tool = null;                 // null = still framing
    let color = getComputedStyle(canvas).getPropertyValue('--nc-ink-default').trim() || '#ff3b30';
    let size = SIZES.medium;
    let drawing = null;
    let editor = null;

    function paint() {
      const rect = getRect();
      if (!rect || !tool) { canvas.hidden = true; return; }
      canvas.hidden = false;
      canvas.style.left = `${rect.x}px`;
      canvas.style.top = `${rect.y}px`;
      canvas.style.width = `${rect.w}px`;
      canvas.style.height = `${rect.h}px`;
      renderer.render(canvas, { bitmap, metrics, rect, ops: ops.all });
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

    function begin(e) {
      const p = local(e);
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
        default:
          return false;
      }
    }

    function move(e) {
      if (!drawing) return false;
      const p = local(e);
      if (drawing.tool === 'pencil' || drawing.tool === 'highlight') {
        drawing.points.push(p);
        ops.preview({ ...drawing, points: [...drawing.points] });
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
      if (!drawing) return false;
      const wasBlur = drawing.tool === 'blur';
      const tooSmall = wasBlur && (drawing.rect.w < 6 || drawing.rect.h < 6);
      drawing = null;
      if (tooSmall) ops.dropPreview();
      else ops.commitPreview();
      return true;
    }

    function openTextEditor(at) {
      editor?.cancel();
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

    function moveLoupe(e) {
      if (tool !== 'zoom') { loupe.hidden = true; return; }
      const rect = getRect();
      if (!rect) { loupe.hidden = true; return; }
      const Z = 3;
      loupe.hidden = false;
      const [lx, ly] = local(e);
      loupe.style.left = `${lx}px`;
      loupe.style.top = `${ly}px`;
      loupe.style.backgroundImage = `url("${bitmap.src}")`;
      loupe.style.backgroundSize = `${metrics.cssWidth * Z}px ${metrics.cssHeight * Z}px`;
      const size = parseFloat(getComputedStyle(loupe).width) || 140;
      loupe.style.backgroundPosition =
        `${-lx * Z + size / 2}px ${-ly * Z + size / 2}px`;
    }

    return {
      get tool() { return tool; },
      setTool(next) {
        editor?.cancel();
        tool = next;
        loupe.hidden = next !== 'zoom';
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
      cancelText: () => editor?.cancel(),
      get editing() { return editor !== null; },
      element: canvas,
    };
  }

  NC.define('annotate', { create, SIZES });
})();
