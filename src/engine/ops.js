/* NhakoCapture — annotation op list
 *
 * Every mark is a record appended to a list, and the image is produced by
 * replaying the list over the base bitmap. Nothing is ever painted
 * irreversibly.
 *
 * This is the whole reason undo works. Painting straight onto a canvas is
 * simpler right up until the moment someone wants their last stroke back, at
 * which point the pixels underneath are gone and no amount of bookkeeping
 * recovers them. Hence: build the list first, then the tools.
 *
 * Ops are stored in viewport CSS coordinates -- the same space as the selection
 * rect -- not in canvas pixels. That keeps annotations anchored to the page
 * content they point at, so moving or resizing the frame afterwards does not
 * drag the arrows away from what they were marking.
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  if (!NC || NC.modules.ops) return;

  function create({ onChange } = {}) {
    let ops = [];
    let undone = [];

    const notify = () => onChange?.();

    return {
      add(op) {
        ops.push(op);
        // A new mark forks history: anything undone is no longer reachable.
        undone = [];
        notify();
        return op;
      },

      /* Live preview during a drag: the in-progress op is replaced on every
       * pointermove rather than appended, so one stroke is one undo step. */
      preview(op) {
        ops[ops.length - 1]?.__preview ? (ops[ops.length - 1] = op) : ops.push(op);
        op.__preview = true;
        notify();
      },

      commitPreview() {
        const last = ops[ops.length - 1];
        if (last?.__preview) {
          delete last.__preview;
          undone = [];
          notify();
        }
      },

      dropPreview() {
        if (ops[ops.length - 1]?.__preview) {
          ops.pop();
          notify();
        }
      },

      undo() {
        if (!ops.length) return false;
        undone.push(ops.pop());
        notify();
        return true;
      },

      redo() {
        if (!undone.length) return false;
        ops.push(undone.pop());
        notify();
        return true;
      },

      clear() {
        if (!ops.length && !undone.length) return;
        ops = [];
        undone = [];
        notify();
      },

      /* Put every op through `fn`, in the undo stack as well as the live list.
       *
       * Ops are recorded in the coordinate space of the surface they were
       * drawn on, and that space can be replaced underneath them -- the
       * fallback editor re-fits the capture when its window is resized. The
       * undo stack has to come along, or undoing after a resize restores a
       * mark to where it would have been in a space that no longer exists. */
      remap(fn) {
        if (!ops.length && !undone.length) return;
        ops = ops.map(fn);
        undone = undone.map(fn);
        notify();
      },

      get all() { return ops; },
      get length() { return ops.length; },
      get canUndo() { return ops.length > 0; },
      get canRedo() { return undone.length > 0; },
    };
  }

  /* Multiply every coordinate and every size in an op by `k`.
   *
   * Pure, and returns a new op rather than mutating: the caller may be holding
   * the old one in an undo stack. Exhaustive over the fields render.js knows
   * how to paint -- a tool that adds a new geometric field without adding it
   * here would keep its old geometry and drift away from what it marked. */
  function scaleOp(op, k) {
    if (!(k > 0) || k === 1) return op;
    const point = ([x, y]) => [x * k, y * k];
    const next = { ...op };

    if (op.points) next.points = op.points.map(point);
    if (op.from) next.from = point(op.from);
    if (op.to) next.to = point(op.to);
    if (op.at) next.at = point(op.at);
    if (op.rect) {
      next.rect = {
        x: op.rect.x * k, y: op.rect.y * k,
        w: op.rect.w * k, h: op.rect.h * k,
      };
    }
    /* Stroke weight and text size are in the same space as the coordinates,
     * so a mark keeps its proportions rather than growing heavier as the
     * capture is scaled down. */
    if (typeof op.size === 'number') next.size = op.size * k;
    if (typeof op.radius === 'number') next.radius = op.radius * k;

    return next;
  }

  NC.define('ops', { create, scaleOp });
})();
