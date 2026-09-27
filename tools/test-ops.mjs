/* Unit tests for src/engine/ops.js
 *
 *   node tools/test-ops.mjs
 *
 * The op list is what makes undo possible, so its history semantics are worth
 * pinning down: a live drag must be one undo step, not one per pointermove, and
 * a new mark must discard the redo branch.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0;
const failures = [];
const eq = (l, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else failures.push(`${l}\n      expected ${JSON.stringify(b)}\n      actual   ${JSON.stringify(a)}`);
};

const sandbox = { console: { warn() {} }, Object, JSON, Array };
sandbox.globalThis = sandbox;
createContext(sandbox);
runInContext(read('src/lib/namespace.js'), sandbox);
runInContext(read('src/engine/ops.js'), sandbox);
const opsModule = sandbox.globalThis.NhakoCapture.require('ops');

let notified = 0;
const make = () => { notified = 0; return opsModule.create({ onChange: () => notified++ }); };

/* --- basics --------------------------------------------------------------- */
{
  const o = make();
  eq('starts empty', o.length, 0);
  eq('nothing to undo', o.canUndo, false);
  eq('nothing to redo', o.canRedo, false);
  o.add({ tool: 'pencil' });
  eq('add appends', o.length, 1);
  eq('now undoable', o.canUndo, true);
  eq('onChange fired', notified, 1);
}

/* --- undo / redo ---------------------------------------------------------- */
{
  const o = make();
  o.add({ tool: 'a' }); o.add({ tool: 'b' }); o.add({ tool: 'c' });
  o.undo();
  eq('undo pops the last op', o.all.map((x) => x.tool), ['a', 'b']);
  eq('redo becomes available', o.canRedo, true);
  o.redo();
  eq('redo restores it', o.all.map((x) => x.tool), ['a', 'b', 'c']);
  eq('redo exhausted', o.canRedo, false);
}

{
  const o = make();
  for (const t of ['a', 'b', 'c', 'd', 'e']) o.add({ tool: t });
  for (let i = 0; i < 5; i++) o.undo();
  eq('undo all the way empties', o.length, 0);
  eq('undo past the start is a no-op', o.undo(), false);
  for (let i = 0; i < 5; i++) o.redo();
  eq('redo all the way restores order', o.all.map((x) => x.tool), ['a', 'b', 'c', 'd', 'e']);
  eq('redo past the end is a no-op', o.redo(), false);
}

/* A new mark after undoing must discard the redo branch -- otherwise redo
 * resurrects a stroke from an abandoned timeline. */
{
  const o = make();
  o.add({ tool: 'a' }); o.add({ tool: 'b' });
  o.undo();
  eq('branch available before the new mark', o.canRedo, true);
  o.add({ tool: 'c' });
  eq('adding forks history and drops the branch', o.canRedo, false);
  eq('and keeps the new mark', o.all.map((x) => x.tool), ['a', 'c']);
}

/* --- live preview: one drag is one undo step ------------------------------ */
{
  const o = make();
  o.add({ tool: 'existing' });
  o.preview({ tool: 'pencil', points: [1] });
  o.preview({ tool: 'pencil', points: [1, 2] });
  o.preview({ tool: 'pencil', points: [1, 2, 3] });
  eq('preview replaces rather than appends', o.length, 2);
  eq('preview holds the latest state', o.all.at(-1).points, [1, 2, 3]);
  o.commitPreview();
  eq('commit keeps exactly one op', o.length, 2);
  o.undo();
  eq('one drag undoes in one step', o.all.map((x) => x.tool), ['existing']);
}

{
  const o = make();
  o.preview({ tool: 'blur' });
  o.dropPreview();
  eq('a discarded preview leaves nothing behind', o.length, 0);
}

/* A preview must not be undoable until committed, or Ctrl+Z mid-drag would
 * fight the drag itself. */
{
  const o = make();
  o.add({ tool: 'a' });
  o.preview({ tool: 'b' });
  o.commitPreview();
  eq('committed preview is a real op', o.length, 2);
  eq('and the marker is gone', '__preview' in o.all.at(-1), false);
}

/* --- clear ---------------------------------------------------------------- */
{
  const o = make();
  o.add({ tool: 'a' }); o.undo();
  o.clear();
  eq('clear empties ops', o.length, 0);
  eq('clear drops the redo branch too', o.canRedo, false);
  const before = notified;
  o.clear();
  eq('clearing an empty list does not notify', notified, before);
}

/* --- remap ----------------------------------------------------------------
 *
 * The fallback editor re-fits its capture when the window is resized, which
 * replaces the coordinate space every op was recorded in. Marks have to follow
 * the image -- and so does the undo stack, or undoing after a resize restores a
 * mark into a space that no longer exists.
 */
{
  const o = make();
  o.add({ tool: 'arrow', from: [10, 20], to: [30, 40], size: 4 });
  o.add({ tool: 'text', at: [50, 60], size: 16 });
  o.undo();                                   // one op live, one undone

  o.remap((op) => opsModule.scaleOp(op, 2));

  eq('remap scales the live op', o.all[0].from, [20, 40]);
  eq('...including its stroke weight', o.all[0].size, 8);
  o.redo();
  eq('remap reached the undo stack too', o.all[1].at, [100, 120]);
  eq('...and its size', o.all[1].size, 32);

  const empty = make();          // resets the notification counter
  empty.remap((op) => op);
  eq('remapping an empty list does not notify', notified, 0);
}

/* --- scaleOp -------------------------------------------------------------- */
{
  const S = opsModule.scaleOp;
  const arrow = { tool: 'arrow', from: [1, 2], to: [3, 4], size: 2 };

  eq('a scale of 1 is a no-op', S(arrow, 1), arrow);
  eq('and does not copy', S(arrow, 1) === arrow, true);
  eq('a nonsense scale is refused rather than applied', S(arrow, 0), arrow);

  eq('pencil points scale',
    S({ tool: 'pencil', points: [[1, 2], [3, 4]] }, 3).points, [[3, 6], [9, 12]]);
  eq('blur rects scale on all four fields',
    S({ tool: 'blur', rect: { x: 1, y: 2, w: 3, h: 4 } }, 2).rect,
    { x: 2, y: 4, w: 6, h: 8 });
  eq('blur radius scales with the region',
    S({ tool: 'blur', rect: { x: 0, y: 0, w: 1, h: 1 }, radius: 8 }, 2).radius, 16);

  const original = { tool: 'arrow', from: [1, 2], to: [3, 4] };
  S(original, 2);
  eq('the original op is never mutated', original.from, [1, 2]);
}

console.log(`\nops: ${pass} passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.error('  FAIL  ' + f); process.exit(1); }
