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

      get all() { return ops; },
      get length() { return ops.length; },
      get canUndo() { return ops.length > 0; },
      get canRedo() { return undone.length > 0; },
    };
  }

  NC.define('ops', { create });
})();
