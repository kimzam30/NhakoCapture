/* Unit tests for src/background.js
 *
 *   node tools/test-background.mjs
 *
 * background.js is a classic (non-module) service-worker script, so its
 * top-level function declarations land on the sandbox global and can be called
 * directly. A stubbed `chrome` records every API call in order, which is how
 * the central invariant of this phase gets verified without a browser:
 * the viewport must be captured BEFORE anything is injected.
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
function ok(label, cond) { eq(label, !!cond, true); }

function loadBackground({ captureFails = false, injectFails = false } = {}) {
  const calls = [];
  const listeners = {};
  const record = (name) => (...args) => { calls.push({ name, args }); };

  const chrome = {
    action: {
      onClicked: { addListener: (fn) => { listeners.action = fn; } },
      setBadgeBackgroundColor: async (...a) => { calls.push({ name: 'setBadgeBackgroundColor', args: a }); },
      setBadgeText: async (...a) => { calls.push({ name: 'setBadgeText', args: a }); },
      setTitle: async (...a) => { calls.push({ name: 'setTitle', args: a }); },
    },
    tabs: {
      captureVisibleTab: async (...a) => {
        calls.push({ name: 'captureVisibleTab', args: a });
        if (captureFails) throw new Error('capture denied');
        return 'data:image/png;base64,AAAA';
      },
      sendMessage: async (...a) => { calls.push({ name: 'tabs.sendMessage', args: a }); return { ok: true }; },
    },
    scripting: {
      executeScript: async (...a) => {
        calls.push({ name: 'executeScript', args: a });
        if (injectFails) throw new Error('injection blocked');
        return [];
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      getContexts: async () => [],
      sendMessage: async (...a) => { calls.push({ name: 'runtime.sendMessage', args: a }); return { ok: true }; },
    },
    offscreen: {
      createDocument: async (...a) => { calls.push({ name: 'createDocument', args: a }); },
    },
    downloads: {
      onChanged: { addListener: (fn) => { listeners.download = fn; } },
      download: async (...a) => { calls.push({ name: 'downloads.download', args: a }); return 7; },
    },
  };

  const sandbox = { chrome, console: { warn() {}, log() {}, info() {}, error() {} }, setTimeout, clearTimeout, Date, JSON, String, Number, Math, Set, Map, Promise, RegExp, Error };
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  runInContext(readFileSync(join(root, 'src/background.js'), 'utf8'), sandbox);
  return { sandbox, calls, listeners, names: () => calls.map((c) => c.name) };
}

/* --- listeners are registered synchronously at top level ----------------- */
{
  const { listeners } = loadBackground();
  ok('action.onClicked listener registered', typeof listeners.action === 'function');
  ok('runtime.onMessage listener registered', typeof listeners.message === 'function');
  ok('downloads.onChanged listener registered', typeof listeners.download === 'function');
}

/* --- isRestricted -------------------------------------------------------- */
{
  const { sandbox } = loadBackground();
  const r = sandbox.isRestricted;

  for (const url of [
    'chrome://settings', 'brave://extensions', 'edge://flags', 'about:blank',
    'view-source:https://example.com', 'devtools://devtools/bundled/x.html',
    'chrome-extension://abc/page.html', 'opera://about', 'vivaldi://settings',
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/detail/x',
    '', undefined,
  ]) eq(`restricted: ${String(url)}`, r(url), true);

  for (const url of [
    'https://example.com', 'http://example.com', 'https://news.ycombinator.com/item?id=1',
    'file:///home/kim/page.html',
    'https://notchromewebstore.google.com.evil.com/',
    // must not match on prefix alone
    'https://chromewebstore.google.com.evil.com/',
    'https://chrome.google.com/webstoreevil',
  ]) eq(`allowed: ${url}`, r(url), false);

  // the real store, in its various shapes, still must be caught
  for (const url of [
    'https://chromewebstore.google.com',
    'https://chromewebstore.google.com/',
    'https://chromewebstore.google.com/detail/abc?hl=en',
    'https://chrome.google.com/webstore',
    'https://chrome.google.com/webstore/detail/abc',
  ]) eq(`restricted store: ${url}`, r(url), true);
}

/* --- THE invariant: capture strictly precedes injection ------------------ */
{
  const { listeners, names } = loadBackground();
  await listeners.action({ id: 1, windowId: 2, url: 'https://example.com' });
  const seq = names();

  const iCapture = seq.indexOf('captureVisibleTab');
  const iInject = seq.indexOf('executeScript');
  const iHandoff = seq.indexOf('tabs.sendMessage');

  ok('capture happened', iCapture !== -1);
  ok('injection happened', iInject !== -1);
  ok('handoff happened', iHandoff !== -1);
  ok('capture BEFORE injection', iCapture < iInject);
  ok('injection BEFORE handoff', iInject < iHandoff);
}

/* --- restricted page: never captures, reports instead -------------------- */
{
  const { listeners, names, calls } = loadBackground();
  await listeners.action({ id: 1, windowId: 2, url: 'brave://settings' });
  const seq = names();
  ok('no capture attempted on a restricted page', !seq.includes('captureVisibleTab'));
  ok('no injection attempted on a restricted page', !seq.includes('executeScript'));
  ok('badge raised instead', seq.includes('setBadgeText'));
  const badge = calls.filter((c) => c.name === 'setBadgeText').pop();
  eq('badge shows a marker', badge.args[0].text, '!');
}

/* --- capture denied: does not go on to inject ---------------------------- */
{
  const { listeners, names } = loadBackground({ captureFails: true });
  await listeners.action({ id: 1, windowId: 2, url: 'https://example.com' });
  const seq = names();
  ok('capture was attempted', seq.includes('captureVisibleTab'));
  ok('injection skipped after a failed capture', !seq.includes('executeScript'));
  ok('failure reported', seq.includes('setBadgeText'));
}

/* --- injection denied: does not go on to hand off ------------------------ */
{
  const { listeners, names } = loadBackground({ injectFails: true });
  await listeners.action({ id: 1, windowId: 2, url: 'https://example.com' });
  const seq = names();
  ok('handoff skipped after a failed injection', !seq.includes('tabs.sendMessage'));
  ok('failure reported', seq.includes('setBadgeText'));
}

/* --- injection order ------------------------------------------------------ */
{
  const { listeners, calls } = loadBackground();
  await listeners.action({ id: 1, windowId: 2, url: 'https://example.com' });
  const inject = calls.find((c) => c.name === 'executeScript');
  eq('namespace.js is injected first', inject.args[0].files[0], 'src/lib/namespace.js');
  eq('inject.js is injected last',
    inject.args[0].files[inject.args[0].files.length - 1], 'src/overlay/inject.js');
  ok('all injected files live under src/', inject.args[0].files.every((f) => f.startsWith('src/')));
}

/* --- save: mints a blob url and opens a real picker ---------------------- */
{
  const { listeners, calls } = loadBackground();
  // offscreen returns a blob url for make-blob-url
  const sent = [];
  listeners.message(
    { type: 'nc:save', dataUrl: 'data:image/png;base64,AAAA' },
    { tab: { id: 1 } },
    (res) => sent.push(res)
  );
  await new Promise((r) => setTimeout(r, 10));
  const dl = calls.find((c) => c.name === 'downloads.download');
  ok('download was requested', !!dl);
  eq('destination picker is opened', dl.args[0].saveAs, true);
  ok('filename is timestamped .png', /^Nhako_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png$/.test(dl.args[0].filename));
}

/* --- offscreen-addressed messages are ignored by the background ---------- */
{
  const { listeners } = loadBackground();
  const handled = listeners.message(
    { target: 'nc-offscreen', op: 'copy-image' }, {}, () => {}
  );
  eq('background does not answer offscreen mail', handled, false);
}

/* --- unknown message types are not claimed ------------------------------- */
{
  const { listeners } = loadBackground();
  eq('unknown type not claimed', listeners.message({ type: 'nc:nonsense' }, {}, () => {}), false);
}

console.log(`\nbackground: ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL  ' + f);
  process.exit(1);
}
