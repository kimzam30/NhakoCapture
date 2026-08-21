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

function loadBackground({ captureFails = false, injectFails = false, cssFails = false,
                         attachFails = false, printFails = false } = {}) {
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
      getURL: (p) => `chrome-extension://testid/${p}`,
      getContexts: async () => [],
      sendMessage: async (...a) => { calls.push({ name: 'runtime.sendMessage', args: a }); return { ok: true }; },
    },
    offscreen: {
      createDocument: async (...a) => { calls.push({ name: 'createDocument', args: a }); },
    },
    storage: { local: { set: async (...a) => { calls.push({ name: 'storage.set', args: a }); },
                        remove: async () => {} } },
    windows: { create: async (...a) => { calls.push({ name: 'windows.create', args: a }); return { id: 9 }; } },
    debugger: {
      attach: async (...a) => {
        calls.push({ name: 'debugger.attach', args: a });
        if (attachFails) throw new Error('another debugger is already attached');
      },
      detach: async (...a) => { calls.push({ name: 'debugger.detach', args: a }); },
      sendCommand: async (target, method, params) => {
        calls.push({ name: `debugger.${method}`, args: [target, params] });
        if (method === 'Page.printToPDF') {
          if (printFails) throw new Error('printToPDF failed');
          return { data: 'JVBERi0xLjQK' };
        }
        return {};
      },
    },
    downloads: {
      onChanged: { addListener: (fn) => { listeners.download = fn; } },
      download: async (...a) => { calls.push({ name: 'downloads.download', args: a }); return 7; },
    },
  };

  // The worker reads its own CSS out of the bundle; stub the read.
  const fetch = async (url) => {
    calls.push({ name: 'fetch', args: [url] });
    if (cssFails) return { ok: false, status: 404 };
    return { ok: true, text: async () => `/* ${url} */` };
  };

  // createImageBitmap is used to size the fallback window to the capture.
  const createImageBitmap = async () => ({ width: 1280, height: 720, close() {} });

  const sandbox = { chrome, fetch, createImageBitmap, console: { warn() {}, log() {}, info() {}, error() {} }, setTimeout, clearTimeout, Date, JSON, String, Number, Math, Set, Map, Promise, RegExp, Error };
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

/* --- restricted page: capture still happens, editing moves to a window ---- */
{
  const { listeners, names, calls } = loadBackground();
  await listeners.action({ id: 1, windowId: 2, url: 'brave://settings' });
  const seq = names();
  ok('the capture is still attempted', seq.includes('captureVisibleTab'));
  ok('no injection attempted on a restricted page', !seq.includes('executeScript'));
  ok('the fallback editor window is opened', seq.includes('windows.create'));
  ok('the capture is handed over through storage', seq.includes('storage.set'));
  ok('capture is stored BEFORE the window opens',
    seq.indexOf('storage.set') < seq.indexOf('windows.create'));
  const win = calls.find((c) => c.name === 'windows.create');
  eq('opens as a popup', win.args[0].type, 'popup');
  ok('pointing at the fallback editor', /src\/fallback\/editor\.html$/.test(win.args[0].url));
  ok('sized within sane bounds',
    win.args[0].width >= 720 && win.args[0].width <= 1400 &&
    win.args[0].height >= 520 && win.args[0].height <= 900,
    `${win.args[0].width}x${win.args[0].height}`);
}

/* --- capture refused outright: nothing to fall back to, so say so --------- */
{
  const { listeners, names, calls } = loadBackground({ captureFails: true });
  await listeners.action({ id: 1, windowId: 2, url: 'brave://settings' });
  const seq = names();
  ok('no editor window when there is no capture', !seq.includes('windows.create'));
  ok('the user is told', seq.includes('setBadgeText'));
  const badge = calls.filter((c) => c.name === 'setBadgeText').pop();
  eq('badge shows a marker', badge.args[0].text, '!');
}

/* --- injectable-looking page that rejects injection ----------------------- */
{
  const { listeners, names } = loadBackground({ injectFails: true });
  await listeners.action({ id: 1, windowId: 2, url: 'https://example.com' });
  const seq = names();
  ok('injection was attempted', seq.includes('executeScript'));
  ok('and the capture is not thrown away -- the editor window opens',
    seq.includes('windows.create'));
}

/* --- overlay injected but never answered ---------------------------------- */
{
  const { listeners, names } = loadBackground();
  // make the handoff fail
  const bg = loadBackground();
  bg.sandbox.chrome.tabs.sendMessage = async () => { throw new Error('no receiving end'); };
  await bg.listeners.action({ id: 1, windowId: 2, url: 'https://example.com' });
  ok('a silent overlay also falls back to the window',
    bg.names().includes('windows.create'));
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

/* --- injection denied: no handoff, but the capture survives -------------- */
{
  const { listeners, names } = loadBackground({ injectFails: true });
  await listeners.action({ id: 1, windowId: 2, url: 'https://example.com' });
  const seq = names();
  ok('handoff skipped after a failed injection', !seq.includes('tabs.sendMessage'));
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

/* --- stylesheets travel in the handoff, not fetched by the content script -- */
{
  const { listeners, calls } = loadBackground();
  await listeners.action({ id: 1, windowId: 2, url: 'https://example.com' });

  const fetched = calls.filter((c) => c.name === 'fetch').map((c) => c.args[0]);
  eq('two stylesheets read from the bundle', fetched.length, 2);
  ok('tokens.css read first', fetched[0].endsWith('src/overlay/tokens.css'));
  ok('overlay.css read second', fetched[1].endsWith('src/overlay/overlay.css'));

  const handoff = calls.find((c) => c.name === 'tabs.sendMessage');
  ok('handoff carries the css', typeof handoff.args[1].cssText === 'string');
  ok('handoff carries the bitmap', handoff.args[1].dataUrl.startsWith('data:image/png'));
  ok('css contains both sheets', handoff.args[1].cssText.split('\n').length >= 2);
}

/* The CSS is read once and cached; a second launch must not re-read it. */
{
  const { listeners, calls } = loadBackground();
  await listeners.action({ id: 1, windowId: 2, url: 'https://example.com' });
  await listeners.action({ id: 1, windowId: 2, url: 'https://example.com' });
  eq('stylesheets are cached across launches',
    calls.filter((c) => c.name === 'fetch').length, 2);
}

/* --- a stylesheet that will not load stops the launch cleanly ------------- */
{
  const { listeners, names } = loadBackground({ cssFails: true });
  await listeners.action({ id: 1, windowId: 2, url: 'https://example.com' });
  const seq = names();
  ok('no handoff when styles fail', !seq.includes('tabs.sendMessage'));
  ok('failure reported', seq.includes('setBadgeText'));
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

/* --- PDF: the debugger route ---------------------------------------------- */
{
  const { listeners, calls, names } = loadBackground();
  await new Promise((res) => listeners.message({ type: 'nc:pdf' }, { tab: { id: 42 } }, res));

  const seq = names();
  ok('debugger attached', seq.includes('debugger.attach'));
  ok('Page.enable before printing', seq.indexOf('debugger.Page.enable') < seq.indexOf('debugger.Page.printToPDF'));
  ok('printToPDF called', seq.includes('debugger.Page.printToPDF'));
  ok('debugger detached', seq.includes('debugger.detach'));
  ok('detach happens after printing',
    seq.lastIndexOf('debugger.detach') > seq.indexOf('debugger.Page.printToPDF'));

  const print = calls.find((c) => c.name === 'debugger.Page.printToPDF');
  eq('backgrounds are printed', print.args[1].printBackground, true);

  const dl = calls.find((c) => c.name === 'downloads.download');
  ok('a download was requested', !!dl);
  eq('destination picker is opened', dl.args[0].saveAs, true);
  ok('saved as .pdf', /^Nhako_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.pdf$/.test(dl.args[0].filename));
  ok('never falls back to the print dialog when the debugger works',
    !seq.includes('executeScript'));
}

/* --- PDF: attach refused (DevTools already open) -------------------------- */
{
  const { listeners, calls, names } = loadBackground({ attachFails: true });
  await new Promise((res) => listeners.message({ type: 'nc:pdf' }, { tab: { id: 42 } }, res));
  const seq = names();
  ok('attach was attempted', seq.includes('debugger.attach'));
  ok('falls back to the print dialog', seq.includes('executeScript'));
  ok('no download is forced on the fallback path', !seq.includes('downloads.download'));
  const inject = calls.find((c) => c.name === 'executeScript');
  ok('the fallback injects a print call', /print/.test(String(inject.args[0].func)));
}

/* --- PDF: printing fails after a successful attach ------------------------
 * The detach MUST still happen. A stranded attachment leaves Chromium's
 * "started debugging this browser" infobar up for the life of the tab.        */
{
  const { listeners, names } = loadBackground({ printFails: true });
  await new Promise((res) => listeners.message({ type: 'nc:pdf' }, { tab: { id: 42 } }, res));
  const seq = names();
  ok('detached even though printing threw', seq.includes('debugger.detach'));
  ok('and still falls back to the print dialog', seq.includes('executeScript'));
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
