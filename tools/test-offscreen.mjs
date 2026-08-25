/* Unit tests for src/offscreen.js
 *
 *   node tools/test-offscreen.mjs
 *
 * offscreen.js is a classic script that expects a DOM, a clipboard and a
 * chrome.runtime. All three are stubbed here rather than pulled in, keeping the
 * zero-dependency rule.
 *
 * The stub that matters is execCommand. It models Chrome's real behaviour --
 * 'copy' acts on THE SELECTION, so with nothing selected it returns false and
 * never fires a copy event. That single detail is what made the rung-2 clipboard
 * fallback dead code from the day it was written, and modelling it honestly is
 * the only way a test can hold the fix in place.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
const ok = (label, cond) => eq(label, !!cond, true);

function makeNode(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [], style: { cssText: '' }, attrs: {},
    parent: null, focused: false,
    set contentEditable(v) { this.attrs.contenteditable = v; },
    get contentEditable() { return this.attrs.contenteditable; },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parent = null;
    },
    remove() { this.parent?.removeChild(this); },
    focus() { this.focused = true; },
  };
}

function loadOffscreen({ apiThrows = false, execAccepts = true, swallowEvent = false } = {}) {
  const body = makeNode('body');
  const listeners = {};
  const execCalls = [];

  const selection = {
    ranges: [],
    get rangeCount() { return this.ranges.length; },
    getRangeAt(i) { return this.ranges[i]; },
    removeAllRanges() { this.ranges = []; },
    addRange(r) { this.ranges.push(r); },
  };

  const document = {
    body,
    createElement: makeNode,
    createRange: () => ({
      node: null,
      selectNodeContents(n) { this.node = n; },
      cloneRange() { return { node: this.node, cloned: true }; },
    }),
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    /* Chrome's behaviour, not a convenience: copy acts on the selection. */
    execCommand(cmd) {
      if (cmd !== 'copy') return false;
      const selected = selection.rangeCount > 0 ? selection.getRangeAt(0).node : null;
      execCalls.push({ selectionCount: selection.rangeCount, selected });
      if (selection.rangeCount === 0) return false;
      if (!swallowEvent) {
        const event = {
          preventDefault() { this.defaultPrevented = true; },
          clipboardData: { data: {}, setData(k, v) { this.data[k] = v; } },
        };
        for (const fn of [...(listeners.copy ?? [])]) fn(event);
        lastCopyEvent = event;
      }
      return execAccepts;
    },
  };

  let lastCopyEvent = null;
  const written = [];
  const revoked = [];
  let messageListener = null;

  const sandbox = {
    document,
    window: { getSelection: () => selection },
    navigator: {
      clipboard: {
        write: async (items) => {
          if (apiThrows) throw new Error('NotAllowedError: Document is not focused');
          written.push(items);
        },
      },
    },
    ClipboardItem: function ClipboardItem(o) { return { ...o }; },
    URL: {
      createObjectURL: () => 'blob:chrome-extension://testid/abc',
      revokeObjectURL: (u) => revoked.push(u),
    },
    fetch: async () => ({ blob: async () => ({ type: 'image/png', size: 4 }) }),
    chrome: {
      runtime: { onMessage: { addListener: (fn) => { messageListener = fn; } } },
    },
    console: { warn() {}, error() {}, log() {} },
    Promise, Error, String, JSON, Set, Math, Number, RegExp, Array, Object,
  };
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(join(root, 'src/offscreen.js'), 'utf8'), sandbox);

  return {
    sandbox, body, listeners, execCalls, written, revoked, selection,
    copyEvent: () => lastCopyEvent,
    message: (msg) => new Promise((resolve) => {
      const handled = messageListener(msg, {}, resolve);
      if (handled === false) resolve(undefined);
    }),
  };
}

const PNG = 'data:image/png;base64,AAAA';

/* --- T2: the rung-2 fallback actually fires now --------------------------- */
{
  // Rung 1 refused, so rung 2 has to carry it. This is the case that has
  // silently never worked.
  const t = loadOffscreen({ apiThrows: true });
  const res = await t.sandbox.copyImage(PNG);

  ok('rung 2 reports success', res?.ok === true);
  eq('rung 2 reports the degraded route', res?.via, 'copy-event-html');
  ok('rung 2 flags itself as degraded', res?.degraded === true);
  ok('rung 2 explains itself to the user', typeof res?.note === 'string' && res.note.length > 0);
  ok('rung 2 keeps the rung-1 error for the log', /NotAllowedError/.test(String(res?.apiError)));
}

{
  // The bug itself: execCommand must never be called with an empty selection,
  // because Chrome answers that with false and no event.
  const t = loadOffscreen({ apiThrows: true });
  await t.sandbox.copyImage(PNG);

  eq('execCommand was called once', t.execCalls.length, 1);
  ok('execCommand saw a selection', t.execCalls[0].selectionCount > 0);
  ok('the selection was the image holder', t.execCalls[0].selected?.tagName === 'DIV');
  ok('the holder actually contained the image',
     t.execCalls[0].selected?.children?.[0]?.tagName === 'IMG');
}

{
  // The holder is a means, not a residue.
  const t = loadOffscreen({ apiThrows: true });
  await t.sandbox.copyImage(PNG);

  eq('holder removed from the document', t.body.children.length, 0);
  eq('copy listener removed', (t.listeners.copy ?? []).length, 0);
  eq('selection left empty', t.selection.rangeCount, 0);
}

{
  // A pre-existing selection belongs to whoever made it.
  const t = loadOffscreen({ apiThrows: true });
  const mine = { node: 'something-else', mine: true };
  t.selection.addRange(mine);
  await t.sandbox.copyImage(PNG);

  eq('prior selection restored', t.selection.rangeCount, 1);
  ok('prior selection is the same one', t.selection.getRangeAt(0).node === 'something-else');
}

{
  // The clipboard payload is our markup, not the serializer's.
  const t = loadOffscreen({ apiThrows: true });
  await t.sandbox.copyImage(PNG);
  const html = t.copyEvent()?.clipboardData.data['text/html'];

  ok('copy event was intercepted', t.copyEvent()?.defaultPrevented === true);
  ok('html flavour written', typeof html === 'string');
  ok('html carries the image', html.includes(PNG) && html.startsWith('<img'));
}

/* --- honesty in the other direction -------------------------------------- */
{
  // execCommand claiming success without the event firing must NOT be reported
  // as a copy. Rung 2 lying is the same class of bug as rung 1 crying wolf.
  const t = loadOffscreen({ apiThrows: true, swallowEvent: true });
  const res = await t.sandbox.copyImage(PNG);
  ok('silent execCommand is not reported as a copy', res?.ok === false);
  ok('and says why', /never fired/.test(String(res?.error)));
}

{
  // Both rungs down: a real failure, reported as one.
  const t = loadOffscreen({ apiThrows: true, execAccepts: false });
  const res = await t.sandbox.copyImage(PNG);
  ok('both rungs failing reports failure', res?.ok === false);
  ok('error names both attempts',
     /api:/.test(String(res?.error)) && /copy-event:/.test(String(res?.error)));
}

/* --- rung 1 is still preferred ------------------------------------------- */
{
  const t = loadOffscreen();
  const res = await t.sandbox.copyImage(PNG);
  eq('clipboard API used when available', res?.via, 'clipboard-api');
  ok('not flagged degraded', !res?.degraded);
  eq('one item written', t.written.length, 1);
  eq('rung 2 never engaged', t.execCalls.length, 0);
  eq('no holder was ever created', t.body.children.length, 0);
}

/* --- T1: the readiness handshake ----------------------------------------- */
{
  const t = loadOffscreen();
  const res = await t.message({ target: 'nc-offscreen', op: 'ping' });
  ok('ping answers ok', res?.ok === true);
}

{
  const t = loadOffscreen();
  const res = await t.message({ target: 'nc-offscreen', op: 'not-a-real-op' });
  ok('unknown op is refused', res?.ok === false);
  ok('and names the op', /not-a-real-op/.test(String(res?.error)));
}

{
  const t = loadOffscreen();
  const res = await t.message({ op: 'ping' }); // no target
  eq('untargeted mail is ignored', res, undefined);
}

/* --- blob urls ------------------------------------------------------------ */
{
  const t = loadOffscreen();
  const made = await t.message({ target: 'nc-offscreen', op: 'make-blob-url', dataUrl: PNG });
  ok('blob url minted', made?.ok === true && String(made.url).startsWith('blob:'));

  await t.message({ target: 'nc-offscreen', op: 'revoke-blob-url', url: made.url });
  eq('blob url revoked', t.revoked, [made.url]);

  await t.message({ target: 'nc-offscreen', op: 'revoke-blob-url', url: made.url });
  eq('revoking twice does not double-revoke', t.revoked.length, 1);
}

console.log(`\noffscreen: ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL  ' + f);
  process.exit(1);
}
