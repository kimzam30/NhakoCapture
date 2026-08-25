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

/* `offscreenSilentFor` is how many runtime.sendMessage calls reject with the
 * "receiving end does not exist" disconnect before the document starts
 * answering. It reproduces the exact shape of the copy bug: createDocument
 * resolves, but offscreen.js has not registered its listener yet. */
function loadBackground({ captureFails = false, injectFails = false, cssFails = false,
                         attachFails = false, printFails = false,
                         offscreenSilentFor = 0, offscreenNeverAnswers = false, windowFails = false,
                         existingContexts = 0, createFails = null } = {}) {
  let sends = 0;
  const calls = [];
  const listeners = {};
  const record = (name) => (...args) => { calls.push({ name, args }); };

  const chrome = {
    action: {
      onClicked: { addListener: (fn) => { listeners.action = fn; } },
      setBadgeBackgroundColor: async (...a) => { calls.push({ name: 'setBadgeBackgroundColor', args: a }); },
      setBadgeText: async (...a) => { calls.push({ name: 'setBadgeText', args: a }); },
      setBadgeTextColor: async (...a) => { calls.push({ name: 'setBadgeTextColor', args: a }); },
      setTitle: async (...a) => { calls.push({ name: 'setTitle', args: a }); },
    },
    tabs: {
      onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } },
      onUpdated: { addListener: (fn) => { listeners.tabUpdated = fn; } },
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
      getContexts: async () => new Array(existingContexts).fill({}),
      sendMessage: async (...a) => {
        calls.push({ name: 'runtime.sendMessage', args: a });
        sends += 1;
        if (offscreenNeverAnswers || sends <= offscreenSilentFor) {
          throw new Error(
            'Could not establish connection. Receiving end does not exist.'
          );
        }
        return { ok: true };
      },
    },
    offscreen: {
      createDocument: async (...a) => {
        calls.push({ name: 'createDocument', args: a });
        if (createFails) throw new Error(createFails);
      },
    },
    storage: { local: { set: async (...a) => { calls.push({ name: 'storage.set', args: a }); },
                        remove: async () => {} } },
    windows: {
      create: async (...a) => {
        calls.push({ name: 'windows.create', args: a });
        if (windowFails) throw new Error('no room for a window');
        return { id: 9 };
      },
    },
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

/* --- T1: offscreen readiness handshake ----------------------------------- */
{
  /* The bug, reproduced: the document exists but is not listening yet. The
   * old code sent the payload straight into that gap and reported failure. */
  const { sandbox, calls } = loadBackground({ offscreenSilentFor: 3 });
  const res = await sandbox.copyImage('data:image/png;base64,AAAA');
  ok('cold offscreen: first copy still succeeds', res?.ok === true);

  const sent = calls.filter((c) => c.name === 'runtime.sendMessage');
  const pings = sent.filter((c) => c.args[0].op === 'ping');
  const payloads = sent.filter((c) => c.args[0].op === 'copy-image');
  ok('cold offscreen: retried the ping', pings.length > 1);
  eq('cold offscreen: payload sent exactly once', payloads.length, 1);
  ok(
    'cold offscreen: no payload before the document answered',
    sent.findIndex((c) => c.args[0].op === 'copy-image') ===
      sent.length - 1
  );
}

{
  // A document that is already listening must not pay for the handshake twice.
  const { sandbox, calls } = loadBackground({ existingContexts: 1 });
  await sandbox.copyImage('data:image/png;base64,AAAA');
  const pings = calls.filter(
    (c) => c.name === 'runtime.sendMessage' && c.args[0].op === 'ping'
  );
  eq('warm offscreen: one ping', pings.length, 1);
  eq('warm offscreen: no createDocument',
     calls.filter((c) => c.name === 'createDocument').length, 0);
}

{
  // Bounded, not infinite: a genuinely dead document must error, not hang.
  const { sandbox, calls } = loadBackground({ offscreenNeverAnswers: true });
  let threw = false;
  try { await sandbox.copyImage('data:image/png;base64,AAAA'); }
  catch { threw = true; }
  ok('dead offscreen: gives up rather than hanging', threw);
  const sent = calls.filter((c) => c.name === 'runtime.sendMessage').length;
  ok(`dead offscreen: retries are bounded (${sent} sends)`, sent > 0 && sent < 40);
}

{
  // Losing the createDocument race is not an error -- the document we wanted
  // now exists, which is all we were trying to achieve.
  const { sandbox } = loadBackground({
    createFails: 'Only a single offscreen document may be created.',
  });
  const res = await sandbox.copyImage('data:image/png;base64,AAAA');
  ok('lost createDocument race: still copies', res?.ok === true);
}

{
  // A real error must not be swallowed by the disconnect retry.
  const { sandbox } = loadBackground({ createFails: 'disk on fire' });
  let threw = false;
  try { await sandbox.copyImage('data:image/png;base64,AAAA'); }
  catch { threw = true; }
  ok('real createDocument error is not swallowed', threw);
}

{
  // The nc:copy route is what the overlay actually calls; it must report the
  // recovered success, not the transient.
  const { sandbox, listeners } = loadBackground({ offscreenSilentFor: 2 });
  const reply = await new Promise((resolve) => {
    listeners.message({ type: 'nc:copy', dataUrl: 'data:image/png;base64,AAAA' },
                      {}, resolve);
  });
  ok('nc:copy reports ok after a cold start', reply?.ok === true);
  ok('nc:copy carries no error', !reply?.error);
}

/* --- T6: the badge as a progress channel --------------------------------- */
{
  const { sandbox } = loadBackground();
  const label = sandbox.progressLabel;

  eq('a short capture shows the literal count', label(3, 9), '3/9');
  eq('the first tile', label(1, 9), '1/9');
  eq('the last tile', label(9, 9), '9/9');
  /* Chrome clips a badge at about four characters, so "10/12" would not
     survive. Ten or more tiles switch to a percentage, which always fits. */
  eq('a long capture switches to a percentage', label(10, 12), '83%');
  eq('and reaches 100%', label(12, 12), '100%');
  ok('no progress label exceeds four characters',
     [[1, 9], [9, 9], [1, 12], [10, 12], [12, 12], [1, 400], [399, 400]]
       .every(([i, n]) => label(i, n).length <= 4));
}

{
  const { sandbox, calls } = loadBackground();
  await sandbox.showProgress(5, 3, 9);

  const text = calls.filter((c) => c.name === 'setBadgeText').pop();
  eq('the badge carries the count', text.args[0].text, '3/9');
  eq('scoped to the tab', text.args[0].tabId, 5);

  const bg = calls.filter((c) => c.name === 'setBadgeBackgroundColor').pop();
  eq('progress uses the progress colour', bg.args[0].color, '#8a2be2');

  const fg = calls.filter((c) => c.name === 'setBadgeTextColor').pop();
  ok('progress sets its text colour explicitly rather than inheriting white',
     fg !== undefined);
  eq('and it is the token value', fg.args[0].color, '#ffffff');

  const title = calls.filter((c) => c.name === 'setTitle').pop();
  ok('the tooltip carries the exact figure the badge may have rounded',
     /3 of 9/.test(title.args[0].title));
}

{
  // The bug this task also fixes: white on #ff453a is 3.41:1.
  const { sandbox, calls } = loadBackground();
  await sandbox.reportFailure(5, 'something went wrong');

  const bg = calls.filter((c) => c.name === 'setBadgeBackgroundColor').pop();
  eq('failure keeps its red', bg.args[0].color, '#ff453a');

  const fg = calls.filter((c) => c.name === 'setBadgeTextColor').pop();
  ok('failure sets its text colour explicitly', fg !== undefined);
  eq('to the dark token, not the default white', fg.args[0].color, '#1c1c1e');
}

{
  const { sandbox, calls } = loadBackground();
  await sandbox.showProgress(5, 3, 9);
  await sandbox.clearProgress(5);

  const text = calls.filter((c) => c.name === 'setBadgeText').pop();
  eq('progress clears to empty', text.args[0].text, '');
  const title = calls.filter((c) => c.name === 'setTitle').pop();
  eq('and the tooltip goes back to idle', title.args[0].title,
     'Nhako Capture (Ctrl+Shift+5)');
}

{
  /* Failure outranks progress, per the IA. A tile that completes after a
     failure must not paint over the one message the user has not seen. */
  const { sandbox, calls } = loadBackground();
  await sandbox.reportFailure(5, 'capture refused');
  const before = calls.length;
  await sandbox.showProgress(5, 4, 9);

  eq('progress does not overwrite a failure', calls.length, before);
  const text = calls.filter((c) => c.name === 'setBadgeText').pop();
  eq('the failure marker still stands', text.args[0].text, '!');
}

{
  // ...and clearing progress must not wipe the failure either.
  const { sandbox, calls } = loadBackground();
  await sandbox.reportFailure(5, 'capture refused');
  const before = calls.length;
  await sandbox.clearProgress(5);

  eq('clearing progress leaves a failure alone', calls.length, before);
}

{
  // A failure on one tab must not silence progress on another.
  const { sandbox, calls } = loadBackground();
  await sandbox.reportFailure(5, 'capture refused');
  await sandbox.showProgress(6, 2, 4);

  const text = calls.filter((c) => c.name === 'setBadgeText').pop();
  eq('the other tab still gets its counter', text.args[0].text, '2/4');
  eq('on its own tab', text.args[0].tabId, 6);
}

{
  // Relaunching clears the suppression, or the next capture shows nothing.
  const { sandbox, calls, listeners } = loadBackground();
  await sandbox.reportFailure(5, 'capture refused');
  await listeners.action({ id: 5, windowId: 1, url: 'https://example.com' });
  await sandbox.showProgress(5, 1, 3);

  const text = calls.filter((c) => c.name === 'setBadgeText').pop();
  eq('progress works again after a relaunch', text.args[0].text, '1/3');
}

{
  // A tab that has gone is not an error path.
  const { sandbox } = loadBackground();
  let threw = false;
  try {
    await sandbox.showProgress(undefined, 1, 3);
    await sandbox.clearProgress(undefined);
  } catch { threw = true; }
  ok('a missing tab is ignored, not thrown on', !threw);
}

{
  // The route the overlay actually uses.
  const { listeners, calls } = loadBackground();
  listeners.message({ type: 'nc:progress', index: 2, total: 5 },
                    { tab: { id: 5 } }, () => {});
  await new Promise((r) => setTimeout(r, 0));
  const text = calls.filter((c) => c.name === 'setBadgeText').pop();
  eq('nc:progress paints the badge', text.args[0].text, '2/5');
}

{
  const { listeners, calls } = loadBackground();
  listeners.message({ type: 'nc:progress', done: true }, { tab: { id: 5 } }, () => {});
  await new Promise((r) => setTimeout(r, 0));
  const text = calls.filter((c) => c.name === 'setBadgeText').pop();
  eq('nc:progress done clears the badge', text.args[0].text, '');
}

/* --- T7: the full-page handoff -------------------------------------------- */
{
  const { sandbox, calls } = loadBackground();
  const res = await sandbox.openFullPageEditor(
    { dataUrl: 'data:image/png;base64,AAAA', width: 2400, height: 12000, capped: false }, 5
  );

  ok('handoff succeeded', res.ok === true);

  const minted = calls.filter(
    (c) => c.name === 'runtime.sendMessage' && c.args[0].op === 'make-blob-url'
  );
  eq('the image was minted as a blob, once', minted.length, 1);

  const stored = calls.filter((c) => c.name === 'storage.set').pop().args[0];
  ok('only the URL goes through storage', 'captureBlobUrl' in stored);
  ok('the image itself does not', !('capturedImage' in stored));
  ok('a short string, nowhere near the quota',
     JSON.stringify(stored).length < 500);

  const created = calls.filter((c) => c.name === 'windows.create').pop().args[0];
  eq('the editor window opens', created.url, 'src/fallback/editor.html');
}

{
  // A 12000px capture must not decode in the worker just to size a window.
  const { sandbox, calls } = loadBackground();
  await sandbox.openFullPageEditor(
    { dataUrl: 'data:image/png;base64,AAAA', width: 2400, height: 12000 }, 5
  );
  const created = calls.filter((c) => c.name === 'windows.create').pop().args[0];
  ok('the window is clamped, not 12000px tall', created.height <= 900);
  ok('and not collapsed to nothing', created.height >= 520);
}

{
  const { sandbox, calls } = loadBackground();
  await sandbox.openFullPageEditor(
    { dataUrl: 'data:image/png;base64,AAAA', width: 2400, height: 12000, capped: true }, 5
  );
  const stored = calls.filter((c) => c.name === 'storage.set').pop().args[0];
  ok('the cap flag reaches the editor', stored.captureCapped === true);
}

{
  const { sandbox, calls } = loadBackground();
  await sandbox.openFullPageEditor(
    { dataUrl: 'data:image/png;base64,AAAA', width: 2400, height: 2000 }, 5
  );
  const stored = calls.filter((c) => c.name === 'storage.set').pop().args[0];
  ok('an uncapped capture says so', stored.captureCapped === false);
}

{
  /* The leak path. If the window never opens, nothing will ever consume the
     URL, and it pins the whole stitched PNG for the life of the offscreen
     document. This is the failure that costs memory silently. */
  const { sandbox, calls } = loadBackground({ windowFails: true });
  const res = await sandbox.openFullPageEditor(
    { dataUrl: 'data:image/png;base64,AAAA', width: 2400, height: 2000 }, 5
  );

  ok('the failure is reported', res.ok === false);
  const revoked = calls.filter(
    (c) => c.name === 'runtime.sendMessage' && c.args[0].op === 'revoke-blob-url'
  );
  eq('the orphaned blob URL is revoked, not leaked', revoked.length, 1);
  ok('the user is told', calls.some((c) => c.name === 'setBadgeText'));
}

{
  // The editor says when it is done with the URL; nothing revokes on a timer.
  const { listeners, calls } = loadBackground();
  listeners.message(
    { type: 'nc:capture-consumed', url: 'blob:chrome-extension://testid/abc' },
    { tab: { id: 5 } }, () => {}
  );
  const revoked = calls.filter(
    (c) => c.name === 'runtime.sendMessage' && c.args[0].op === 'revoke-blob-url'
  );
  eq('consuming the capture revokes its URL', revoked.length, 1);
  eq('the right one', revoked[0].args[0].url, 'blob:chrome-extension://testid/abc');
}

{
  // The restricted-page path is untouched and still uses storage.
  const { sandbox, calls } = loadBackground();
  await sandbox.openFallback('data:image/png;base64,AAAA', 5);

  const stored = calls.filter((c) => c.name === 'storage.set').pop().args[0];
  ok('a restricted-page capture still travels as a data URL',
     typeof stored.capturedImage === 'string');
  ok('and mints no blob', !calls.some(
    (c) => c.name === 'runtime.sendMessage' && c.args[0].op === 'make-blob-url'));
}

{
  // The route the overlay actually calls.
  const { listeners } = loadBackground();
  const reply = await new Promise((resolve) => {
    listeners.message(
      { type: 'nc:full-page-done', dataUrl: 'data:image/png;base64,AAAA',
        width: 1200, height: 5000, capped: false },
      { tab: { id: 5 } }, resolve
    );
  });
  ok('nc:full-page-done reports success', reply?.ok === true);
}

/* --- T10: a tab that leaves must not strand its counter ------------------ */
{
  const { sandbox, calls, listeners } = loadBackground();
  await sandbox.showProgress(5, 4, 9);
  calls.length = 0;

  listeners.tabUpdated(5, { status: 'loading' }, {});
  const text = calls.filter((c) => c.name === 'setBadgeText').pop();
  eq('navigating away clears the counter', text.args[0].text, '');
  const title = calls.filter((c) => c.name === 'setTitle').pop();
  eq('and the tooltip stops claiming a capture', title.args[0].title,
     'Nhako Capture (Ctrl+Shift+5)');
}

{
  // A completed load is not a new navigation; only 'loading' is.
  const { calls, listeners } = loadBackground();
  calls.length = 0;
  listeners.tabUpdated(5, { status: 'complete' }, {});
  eq('a finished load does not touch the badge',
     calls.filter((c) => c.name === 'setBadgeText').length, 0);
}

{
  // A closed tab must not keep suppressing progress for its recycled id.
  const { sandbox, calls, listeners } = loadBackground();
  await sandbox.reportFailure(5, 'capture refused');
  listeners.tabRemoved(5, {});
  calls.length = 0;
  await sandbox.showProgress(5, 1, 3);

  const text = calls.filter((c) => c.name === 'setBadgeText').pop();
  eq('a closed tab releases its failure suppression', text.args[0].text, '1/3');
}

{
  // Navigation clears suppression too, so the next capture is not swallowed.
  const { sandbox, calls, listeners } = loadBackground();
  await sandbox.reportFailure(5, 'capture refused');
  listeners.tabUpdated(5, { status: 'loading' }, {});
  calls.length = 0;
  await sandbox.showProgress(5, 2, 4);

  const text = calls.filter((c) => c.name === 'setBadgeText').pop();
  eq('navigating releases the suppression as well', text.args[0].text, '2/4');
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
