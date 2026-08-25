/* Unit tests for src/overlay/fullpage.js
 *
 *   node tools/test-fullpage.mjs
 *
 * The loop drives the live page, so the stub is a small but honest document:
 * a style object that round-trips cssText, a scrollTo that REFUSES TO MOVE
 * while the document is overflow:hidden, elements with computed positions, and
 * a captureVisibleTab that records the state it was called in.
 *
 * That scrollTo detail is not incidental. The overlay pins the page with
 * `overflow: hidden`, and an earlier version of this stub let scrollTo move
 * anyway -- so the tests happily passed a loop that could not have scrolled a
 * single pixel in a real browser. A stub that cannot express the bug cannot
 * catch it.
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

/* A style object faithful enough to catch a bad restore: assigning cssText
 * replaces everything, which is exactly the property the restore relies on. */
function makeStyle(cssText = '') {
  const props = new Map();
  const api = {
    setProperty(k, v) { props.set(k, v); },
    removeProperty(k) { props.delete(k); },
    getPropertyValue(k) { return props.get(k) ?? ''; },
    get cssText() {
      return [...props].map(([k, v]) => `${k}: ${v}`).join('; ');
    },
    set cssText(text) {
      props.clear();
      for (const part of String(text).split(';')) {
        const i = part.indexOf(':');
        if (i > 0) props.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
      }
    },
  };
  for (const [prop, css] of [['scrollBehavior', 'scroll-behavior'],
                             ['overflow', 'overflow'],
                             ['position', 'position'],
                             ['visibility', 'visibility']]) {
    Object.defineProperty(api, prop, {
      get: () => props.get(css) ?? '',
      set: (v) => props.set(css, v),
    });
  }
  api.cssText = cssText;
  return api;
}

function makeElement(position, cssText = '') {
  return { __position: position, style: makeStyle(cssText) };
}

function load({
  docHeight = 4500, viewHeight = 900, viewWidth = 1200,
  quotaFor = 0, failAt = -1,
  refuseScrollPast = Infinity,
  scrollBehavior = 'smooth',
  locked = true,               // the overlay's own overflow:hidden
  elements = [],
  images = [],
  growsTo = null,              // lazy content: height after the sweep reaches the end
} = {}) {
  const captures = [];
  let scrollY = 0;
  let hidden = false;
  let captureCount = 0;
  let height = docHeight;

  const rootStyle = makeStyle(
    `scroll-behavior: ${scrollBehavior}` + (locked ? '; overflow: hidden' : '')
  );
  const documentElement = { style: rootStyle };

  const sandbox = {
    document: {
      documentElement,
      get body() { return { scrollHeight: height, offsetHeight: height }; },
      querySelectorAll: () => elements,
      get images() { return images; },
    },
    getComputedStyle: (el) => ({ position: el.__position ?? 'static' }),
    get window() { return sandbox; },
    innerHeight: viewHeight,
    innerWidth: viewWidth,
    get scrollY() { return scrollY; },
    get scrollX() { return 0; },
    scrollTo(opts) {
      /* The real thing: a document pinned with overflow:hidden does not
       * scroll, whatever you ask of it. */
      if (rootStyle.overflow === 'hidden') return;
      const limit = Math.min(refuseScrollPast, Math.max(0, height - viewHeight));
      scrollY = Math.max(0, Math.min(opts.top, limit));
      // Lazy content arrives once the sweep has actually reached the bottom.
      if (growsTo && scrollY >= limit && height < growsTo) height = growsTo;
    },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    setTimeout, clearTimeout, Date,
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type !== 'nc:capture-tile') return { ok: false };
          const index = captureCount++;
          if (index < quotaFor) {
            return { ok: false, quota: true,
                     error: 'MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded' };
          }
          if (index === failAt) return { ok: false, error: 'tab is not capturable' };
          captures.push({
            scrollY, hidden,
            fixedVisible: elements
              .filter((e) => e.__position === 'fixed')
              .every((e) => e.style.visibility !== 'hidden'),
          });
          return { ok: true, dataUrl: `tile@${scrollY}` };
        },
      },
    },
    console: { info() {}, warn() {}, error() {} },
    Promise, Error, String, Number, Math, JSON, RegExp, Array, Object, Set, Map, isNaN, NaN,
  };
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(join(root, 'src/lib/namespace.js'), 'utf8'), sandbox);
  runInContext(readFileSync(join(root, 'src/lib/geometry.js'), 'utf8'), sandbox);
  runInContext(readFileSync(join(root, 'src/overlay/fullpage.js'), 'utf8'), sandbox);

  const NC = sandbox.globalThis.NhakoCapture;
  return {
    F: NC.require('fullpage'),
    CEILING: NC.require('geometry').CEILING_DEVICE_PX,
    captures, rootStyle, elements,
    state: () => ({ scrollY, hidden, height }),
    hide: () => { hidden = true; },
    show: () => { hidden = false; },
    setScroll: (y) => { scrollY = y; },
  };
}

/* Every test overrides pacing and the pre-pass: asserting the loop's LOGIC
 * does not require sitting through its WAITING. Both are asserted on their own
 * further down, at production settings. */
const FAST = { minInterval: 0, quotaBackoff: 1, prePass: false };
const run = (t, extra = {}) =>
  t.F.run({ hide: t.hide, show: t.show, scaleY: 1, ...FAST, ...extra });

/* --- the scroll lock must be lifted, or nothing scrolls at all ------------ */
{
  /* This is the bug T5 found in T3: with the overlay's overflow:hidden left
     in place, every tile is taken at scrollY 0. */
  const t = load({ docHeight: 2700, viewHeight: 900, locked: true });
  const res = await run(t);

  eq('the page actually scrolled', t.captures.map((c) => c.scrollY), [0, 900, 1800]);
  ok('three distinct tiles, not three copies of the top',
     new Set(res.tiles.map((x) => x.y)).size === 3);
  eq('the lock is restored afterwards', t.rootStyle.overflow, 'hidden');
  eq('and scroll-behavior with it', t.rootStyle.scrollBehavior, 'smooth');
}

/* --- the central invariant: never captured while visible ------------------ */
{
  const t = load({ docHeight: 2700, viewHeight: 900 });
  const res = await run(t);

  ok('run succeeded', res.ok === true);
  eq('one tile per stop', res.tiles.length, 3);
  ok('every capture happened with the overlay hidden',
     t.captures.length > 0 && t.captures.every((c) => c.hidden === true));
}

/* --- tiles are placed where the page actually went ------------------------ */
{
  const t = load({ docHeight: 2700, viewHeight: 900, refuseScrollPast: 1000 });
  const res = await run(t);
  eq('tile offsets are the observed ones', res.tiles.map((x) => x.y), [0, 900, 1000]);
  ok('tile payloads match their offsets',
     res.tiles.every((x) => x.dataUrl === `tile@${x.y}`));
}

{
  const t = load({ docHeight: 2700, viewHeight: 900, refuseScrollPast: 0 });
  const res = await run(t);
  eq('a frozen page collapses to one tile', res.tiles.length, 1);
  eq('and it is the top', res.tiles[0].y, 0);
}

/* --- T5: sticky is un-stuck, fixed survives exactly one tile --------------- */
{
  const sticky = makeElement('sticky', 'top: 0px; z-index: 5');
  const fixed = makeElement('fixed', 'top: 0px; background: red');
  const plain = makeElement('static', 'color: blue');
  const t = load({ docHeight: 2700, viewHeight: 900, elements: [sticky, fixed, plain] });

  const res = await run(t);

  eq('both pinned kinds were found', res.pinned, { sticky: 1, fixed: 1 });
  ok('the fixed element is in the first tile, where it belongs',
     t.captures[0].fixedVisible === true);
  ok('and in none of the others',
     t.captures.slice(1).every((c) => c.fixedVisible === false));
}

{
  // Restoration is by recorded cssText, so pre-existing inline styles survive
  // exactly -- including ones our mutation overwrote.
  const sticky = makeElement('sticky', 'position: sticky; top: 12px; z-index: 5');
  const fixed = makeElement('fixed', 'visibility: visible; top: 0px');
  const before = { sticky: sticky.style.cssText, fixed: fixed.style.cssText };
  const t = load({ docHeight: 2700, viewHeight: 900, elements: [sticky, fixed] });

  await run(t);

  eq('sticky restored byte for byte', sticky.style.cssText, before.sticky);
  eq('fixed restored byte for byte', fixed.style.cssText, before.fixed);
}

{
  // ...and on every abnormal exit too.
  const sticky = makeElement('sticky', 'top: 12px');
  const fixed = makeElement('fixed', 'top: 0px');
  const before = { sticky: sticky.style.cssText, fixed: fixed.style.cssText };
  const t = load({ docHeight: 2700, viewHeight: 900, elements: [sticky, fixed], failAt: 1 });

  const res = await run(t);

  ok('the capture failed', res.ok === false);
  eq('sticky still restored', sticky.style.cssText, before.sticky);
  eq('fixed still restored', fixed.style.cssText, before.fixed);
  eq('the scroll lock still restored', t.rootStyle.overflow, 'hidden');
}

{
  const sticky = makeElement('sticky', 'top: 12px');
  const t = load({ docHeight: 2700, viewHeight: 900, elements: [sticky] });
  let calls = 0;
  const res = await run(t, { shouldCancel: () => (calls += 1) > 4 });

  ok('cancelled', res.cancelled === true);
  eq('sticky restored after a cancel', sticky.style.cssText, 'top: 12px');
  eq('the lock restored after a cancel', t.rootStyle.overflow, 'hidden');
}

/* --- restore, on every path ---------------------------------------------- */
{
  const t = load({ docHeight: 2700, viewHeight: 900 });
  t.setScroll(640);
  const res = await run(t);
  ok('success: scroll restored', t.state().scrollY === 640);
  ok('success: overlay shown again', t.state().hidden === false);
  ok('success reported', res.ok === true);
}

{
  const t = load({ docHeight: 2700, viewHeight: 900 });
  t.setScroll(300);
  let calls = 0;
  const res = await run(t, { shouldCancel: () => (calls += 1) > 3 });
  ok('cancel is reported as cancelled, not as an error', res.cancelled === true);
  ok('cancel: not reported ok', res.ok === false);
  ok('cancel: scroll restored', t.state().scrollY === 300);
  ok('cancel: overlay shown again', t.state().hidden === false);
}

{
  const t = load({ docHeight: 2700, viewHeight: 900, failAt: 1 });
  t.setScroll(120);
  const res = await run(t);
  ok('refusal is an error, not a cancel', res.ok === false && !res.cancelled);
  ok('refusal names the reason', /not capturable/.test(String(res.error)));
  ok('refusal: scroll restored', t.state().scrollY === 120);
  ok('refusal: overlay shown again', t.state().hidden === false);
}

/* --- the rate limit costs a delay, never a tile --------------------------- */
{
  const t = load({ docHeight: 1800, viewHeight: 900, quotaFor: 2 });
  const res = await run(t);
  ok('quota rejections were retried, not surfaced', res.ok === true);
  eq('no tile was dropped', res.tiles.length, 2);
}

/* --- the ceiling ---------------------------------------------------------- */
{
  const t = load({ docHeight: 40000, viewHeight: 900 });
  const res = await run(t);
  ok('an over-tall page is flagged capped', res.capped === true);
  ok('the cap is honoured', res.documentHeight <= t.CEILING);
  ok('the true height is still reported', res.fullDocumentHeight === 40000);
}

{
  const t = load({ docHeight: 12000, viewHeight: 900 });
  const res = await run(t, { scaleY: 2 });
  ok('dpr is applied to the ceiling', res.capped === true);
  ok('capped to half the CSS height', res.documentHeight === 8192);
}

{
  const t = load({ docHeight: 2700, viewHeight: 900 });
  const res = await run(t);
  ok('a normal page is not flagged capped', res.capped === false);
}

/* --- progress ------------------------------------------------------------- */
{
  const t = load({ docHeight: 2700, viewHeight: 900 });
  const seen = [];
  await run(t, { onProgress: (i, n) => seen.push(`${i}/${n}`) });
  eq('progress counts every tile with a known denominator', seen, ['1/3', '2/3', '3/3']);
}

/* --- T5: the lazy-load pre-pass ------------------------------------------- */
{
  /* A page that only reveals its true height once you have scrolled to the
     bottom. Planning before the sweep would capture a third of it. */
  const t = load({ docHeight: 1800, viewHeight: 900, growsTo: 3600 });
  const res = await run(t, { prePass: true, prepassDelay: 0 });

  eq('the plan reflects the grown document', res.tiles.length, 4);
  eq('and covers its full height', res.documentHeight, 3600);
  eq('capture still started from the top', res.tiles[0].y, 0);
}

{
  const t = load({ docHeight: 1800, viewHeight: 900 });
  t.setScroll(450);
  const res = await run(t, { prePass: true, prepassDelay: 0 });
  ok('the pre-pass does not disturb the restore', t.state().scrollY === 450);
  ok('and the capture still succeeded', res.ok === true);
}

{
  // A never-completing image must not hold the capture hostage.
  const t = load({
    docHeight: 900, viewHeight: 900,
    images: [{ complete: false }, { complete: true }],
  });
  const startedAt = Date.now();
  const res = await run(t, { prePass: true, prepassDelay: 0 });
  const elapsed = Date.now() - startedAt;

  ok('the capture completed anyway', res.ok === true);
  ok(`the image wait is bounded (${elapsed}ms)`, elapsed < 4000);
}

{
  // Cancelling during the sweep, before any tile exists.
  const t = load({ docHeight: 9000, viewHeight: 900 });
  const res = await run(t, { prePass: true, prepassDelay: 0, shouldCancel: () => true });
  ok('cancelled during the pre-pass', res.cancelled === true);
  eq('the lock is still restored', t.rootStyle.overflow, 'hidden');
}

/* --- pacing, asserted once at production settings ------------------------- */
{
  const t = load({ docHeight: 1800, viewHeight: 900 });
  const startedAt = Date.now();
  const res = await t.F.run({ hide: t.hide, show: t.show, scaleY: 1, prePass: false });
  const elapsed = Date.now() - startedAt;

  eq('two tiles at production pacing', res.tiles.length, 2);
  ok(`consecutive captures are spaced by the rate limit (${elapsed}ms)`,
     elapsed >= t.F.MIN_CAPTURE_INTERVAL);
}

console.log(`\nfullpage: ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL  ' + f);
  process.exit(1);
}
