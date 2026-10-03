/* NhakoCapture — background service worker
 *
 * Orchestrates one thing above all: the viewport is captured BEFORE any of our
 * UI exists. v1 did the opposite -- draw the overlay, remove it on click,
 * setTimeout(200), then capture and hope the repaint had landed. On a slow
 * frame that puts the extension's own toolbar inside the user's screenshot.
 *
 * Capturing first makes that structurally impossible rather than merely
 * unlikely, and it is also what produces the frozen-page feel the whole design
 * rests on: the overlay paints a still bitmap, so the page cannot move under a
 * selection that has already been drawn.
 */
'use strict';

const OFFSCREEN_TARGET = 'nc-offscreen';
const OFFSCREEN_PATH = 'src/offscreen.html';

/* Injected in this order. namespace.js must be first; it is what the others
 * attach to. See src/lib/namespace.js for why there is no bundler. */
const OVERLAY_FILES = [
  'src/lib/namespace.js',
  'src/lib/geometry.js',
  'src/lib/clipboard.js',
  'src/engine/ops.js',
  'src/engine/render.js',
  'src/engine/stitch.js',
  'src/overlay/stage.js',
  'src/overlay/selection.js',
  'src/overlay/annotate.js',
  'src/overlay/rail.js',
  'src/overlay/toolbar.js',
  'src/overlay/fullpage.js',
  'src/overlay/inject.js',
];

/* Read here and passed to the overlay in the handoff, rather than fetched by
 * the content script. A service worker can always read its own resources, which
 * keeps these files out of web_accessible_resources and means the host page's
 * CSP never enters into it. tokens.css must come first -- overlay.css consumes
 * the custom properties it declares. */
const STYLE_FILES = ['src/overlay/tokens.css', 'src/overlay/overlay.css'];

let styleCache = null;

async function overlayStyles() {
  if (styleCache !== null) return styleCache;
  const parts = await Promise.all(
    STYLE_FILES.map(async (path) => {
      const res = await fetch(chrome.runtime.getURL(path));
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return res.text();
    })
  );
  styleCache = parts.join('\n');
  return styleCache;
}

/* Pages where content scripts cannot run at all. Checking up front lets us give
 * a real reason instead of surfacing an opaque injection error. */
const RESTRICTED_SCHEME =
  /^(chrome|brave|edge|opera|vivaldi|about|devtools|view-source|chrome-extension|moz-extension|chrome-search|chrome-untrusted):/i;
// The trailing boundary matters: without it "chromewebstore.google.com.evil.com"
// matches the prefix and we would refuse to capture an unrelated site.
const WEB_STORE =
  /^https:\/\/(chromewebstore\.google\.com(?=[/?#]|$)|chrome\.google\.com\/webstore(?=[/?#]|$))/i;

function isRestricted(url) {
  return !url || RESTRICTED_SCHEME.test(url) || WEB_STORE.test(url);
}

/* --- the action badge ----------------------------------------------------- */

/* Mirrors the --nc-badge-* tokens in src/overlay/tokens.css. A service worker
 * has no CSS and cannot read that file, so these values necessarily exist in
 * two places; tools/test-tokens.mjs fails the build if the two ever disagree.
 * A comment would not have held this. A red test does.
 *
 * Text colour is set EXPLICITLY in both states. Chrome defaults badge text to
 * white: white on the brand pink is 2.0:1 and on the red 3.41:1, both under
 * the 4.5:1 floor. Plum on the pink is 8.75:1; near-black on the red 4.99:1. */
const BADGE = {
  progress:     '#ff91e7',  // --nc-badge-progress      (via --nc-accent, --nc-pink)
  progressText: '#2a0f26',  // --nc-badge-progress-text
  error:        '#ff453a',  // --nc-badge-error         (via --nc-error)
  errorText:    '#1c1c1e',  // --nc-badge-error-text
};

/* The tooltip at rest. It names the shortcut the browser ACTUALLY has on
 * record rather than the one the manifest suggested: the suggestion is only a
 * suggestion (it is ⌘⇧2 on a Mac, since macOS owns ⌘⇧5), it is silently
 * dropped when another extension already holds the keys, and people rebind it.
 * A tooltip promising Ctrl+Shift+5 to a Mac user was simply wrong. */
const NAME = 'NhakoCapture';
let idleTitle = NAME;

async function refreshIdleTitle() {
  if (!chrome.commands?.getAll) return;
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find((c) => c.name === '_execute_action')?.shortcut;
    idleTitle = shortcut ? `${NAME} (${shortcut})` : NAME;
    await chrome.action.setTitle({ title: idleTitle });
  } catch {
    /* Keep the plain name. A tooltip is not worth failing startup over. */
  }
}
refreshIdleTitle();
chrome.commands?.onChanged?.addListener?.(refreshIdleTitle);

const FAILURE_BADGE_MS = 5000;

/* A tab showing a failure is not overwritten by progress, and clearing
 * progress does not wipe a failure. Failure is the more important thing the
 * user could be told, and it is also the one they have not seen yet. */
const failingTabs = new Set();

async function paintBadge(tabId, { text, color, textColor, title }) {
  if (tabId === undefined || tabId === null) return;
  try {
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
    /* Older Chromium has no setBadgeTextColor. Losing the explicit colour
     * costs contrast, not function, so it is optional rather than fatal. */
    if (textColor) await chrome.action.setBadgeTextColor?.({ tabId, color: textColor });
    await chrome.action.setBadgeText({ tabId, text });
    if (title !== undefined) await chrome.action.setTitle({ tabId, title });
  } catch {
    /* Tab closed while we were painting. Nothing left to paint on. */
  }
}

/* Chrome fits roughly four characters in a badge before clipping, so "10/12"
 * does not survive. Under ten tiles the literal count is shown, because it is
 * the most concrete thing we can say and it is what the IA asked for; at ten
 * or more it becomes a percentage, the only bounded form that always fits.
 * The format is chosen once per capture from a total known up front, so it
 * never changes mid-run. The tooltip carries the exact figure either way. */
function progressLabel(index, total) {
  if (total <= 9) return `${index}/${total}`;
  return `${Math.round((index / total) * 100)}%`;
}

async function showProgress(tabId, index, total) {
  if (failingTabs.has(tabId)) return;
  await paintBadge(tabId, {
    text: progressLabel(index, total),
    color: BADGE.progress,
    textColor: BADGE.progressText,
    title: `${NAME} — capturing the whole page, ${index} of ${total}`,
  });
}

async function clearProgress(tabId) {
  if (failingTabs.has(tabId)) return;
  await paintBadge(tabId, { text: '', title: idleTitle });
}

/* A tab that navigates or closes takes its content script with it, so nothing
 * in the page will ever send the `done` that clears its counter. Without this,
 * a capture interrupted by a navigation leaves a badge frozen at 4/9 on a tab
 * that is not capturing anything -- the toolbar asserting work that is not
 * happening, which is the one thing a progress indicator must never do.
 *
 * Neither listener needs the "tabs" permission: tab events are delivered
 * regardless, and only the sensitive fields (url, title, favicon) are withheld
 * without it. `status` is not one of them. */
chrome.tabs.onRemoved.addListener((tabId) => {
  failingTabs.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  failingTabs.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: idleTitle }).catch(() => {});
});

/* --- user-visible failure ------------------------------------------------ */

/* No notifications permission: a red badge on our own action costs nothing and
 * cannot be blocked by the page. When an overlay is up, it reports in its own
 * pill instead. */
async function reportFailure(tabId, short, detail) {
  console.warn('[NhakoCapture]', short, detail ?? '');
  failingTabs.add(tabId);
  await paintBadge(tabId, {
    text: '!',
    color: BADGE.error,
    textColor: BADGE.errorText,
    title: `${NAME} — ${short}${detail ? `\n${detail}` : ''}`,
  });
  setTimeout(() => {
    failingTabs.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    chrome.action.setTitle({ tabId, title: idleTitle }).catch(() => {});
  }, FAILURE_BADGE_MS);
}

/* --- launch -------------------------------------------------------------- */

async function captureViewport(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

/* One tile of a full-page capture. Unlike captureViewport this never throws:
 * the overlay's loop needs to tell a rate-limit rejection (wait and retry)
 * apart from a refusal (stop), and an exception across the message boundary
 * arrives as an opaque string that cannot be told apart from either. */
async function captureTile(windowId, tabId) {
  if (windowId === undefined || windowId === null) {
    return { ok: false, error: 'no window to capture' };
  }
  /* captureVisibleTab photographs whichever tab is ACTIVE in the window, not
   * the tab that asked. A whole-page capture takes several seconds, and a user
   * who switched tabs in the middle of one got the other tab's pixels stitched
   * into their page, with nothing to say so. Refused here, and reported as
   * `hidden` so the loop waits for them to come back instead of failing.
   *
   * tabs.query needs no permission for the two fields read here. */
  if (tabId !== undefined && tabId !== null && chrome.tabs.query) {
    try {
      const [active] = await chrome.tabs.query({ active: true, windowId });
      if (active && active.id !== tabId) {
        return { ok: false, hidden: true, error: 'the tab is in the background' };
      }
    } catch { /* cannot tell; let the capture decide */ }
  }
  try {
    return { ok: true, dataUrl: await captureViewport(windowId) };
  } catch (err) {
    const message = String(err?.message ?? err);
    return {
      ok: false,
      error: message,
      quota: /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(message),
    };
  }
}

/* Pages where a content script cannot run get the fallback editor window
 * instead. Sized to the capture where possible so the image is not letterboxed
 * into a strip, and clamped so it cannot open larger than the display. */
const FALLBACK_MIN = { width: 720, height: 520 };
const FALLBACK_MAX = { width: 1400, height: 900 };

const EDITOR_CHROME = { width: 32, height: 96 }; // window frame + our toolbars

function editorWindowSize(width, height) {
  const fit = (value, min, max) => Math.round(Math.min(Math.max(value, min), max));
  return {
    width: fit(width + EDITOR_CHROME.width, FALLBACK_MIN.width, FALLBACK_MAX.width),
    height: fit(height + EDITOR_CHROME.height, FALLBACK_MIN.height, FALLBACK_MAX.height),
  };
}

/* Only needed when the dimensions are not already known. A full-page capture
 * knows its own size and skips this: decoding a 16000px image purely to pick a
 * window size would be the largest allocation in the whole feature, done for
 * two integers we were already told. */
async function fallbackWindowSize(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const size = editorWindowSize(bmp.width, bmp.height);
    bmp.close();
    return size;
  } catch {
    return { width: 1100, height: 760 };
  }
}

async function openEditorWindow(payload, size) {
  await chrome.storage.local.set(payload);
  await chrome.windows.create({
    url: 'src/fallback/editor.html',
    type: 'popup',
    focused: true,
    ...size,
  });
}

/* Restricted pages: the capture is a single viewport, comfortably inside
 * storage.local's quota, and this path is unchanged. */
async function openFallback(dataUrl, tabId) {
  try {
    await openEditorWindow({ capturedImage: dataUrl }, await fallbackWindowSize(dataUrl));
    return true;
  } catch (err) {
    await reportFailure(tabId, 'couldn’t open the editing window', String(err));
    return false;
  }
}

/* Full-page captures go through a blob URL instead.
 *
 * storage.local caps at about 10MB without the unlimitedStorage permission,
 * and a data URL pays a further 33% in base64 on top of an image that is
 * already the tallest thing this extension produces -- so the storage route
 * this replaces would fail exactly on the captures worth taking. Only the URL
 * itself, a short string, goes through storage.
 *
 * The blob is minted in the offscreen document because it is the one context
 * that has both URL.createObjectURL and a lifetime we control, and it is
 * revoked there too: a blob URL can only be revoked from the context that
 * created it. */
async function openFullPageEditor({ dataUrl, width, height, capped }, tabId) {
  let made;
  try {
    made = await askOffscreen('make-blob-url', { dataUrl });
  } catch (err) {
    await reportFailure(tabId, 'couldn’t get the capture ready', String(err));
    return { ok: false, error: String(err) };
  }
  if (!made?.ok) {
    await reportFailure(tabId, 'couldn’t get the capture ready', made?.error);
    return made ?? { ok: false, error: 'offscreen did not respond' };
  }

  try {
    await openEditorWindow(
      { captureBlobUrl: made.url, captureCapped: capped === true },
      editorWindowSize(width, height)
    );
    return { ok: true, url: made.url, size: made.size };
  } catch (err) {
    /* The window never opened, so nothing will ever consume this URL and it
     * would pin the whole PNG in memory for the life of the offscreen
     * document. */
    revokeBlobUrl(made.url);
    await reportFailure(tabId, 'couldn’t open the editing window', String(err));
    return { ok: false, error: String(err) };
  }
}

/* True when an overlay was up on this tab and has now been told to close.
 * A tab with no content script rejects with "Receiving end does not exist",
 * which is the ordinary case and simply means there is nothing to dismiss. */
async function dismissOverlay(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'nc:dismiss' }, { frameId: 0 });
    return res?.dismissed === true;
  } catch {
    return false;
  }
}

async function launch(tab) {
  if (!tab?.id) return;

  // Clear any leftover failure badge from a previous attempt -- including the
  // suppression flag, or progress on this run would be silently swallowed.
  failingTabs.delete(tab.id);
  chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {});

  /* A second press while the overlay is up closes it. Without this check the
   * capture below photographed our own scrim and pill, and the "new" overlay
   * froze a dimmed copy of the old one -- the one thing capturing first was
   * supposed to make impossible. */
  if (!isRestricted(tab.url) && await dismissOverlay(tab.id)) return;

  /* Capture first, always -- before any UI of ours exists, and before deciding
   * where the capture is going to be edited. */
  let dataUrl;
  try {
    dataUrl = await captureViewport(tab.windowId);
  } catch (err) {
    await reportFailure(
      tab.id,
      'can’t capture this page',
      'The browser keeps its own pages and the Web Store off-limits to extensions.'
    );
    console.warn('[NhakoCapture] capture refused:', err);
    return;
  }

  // Known-restricted pages skip the injection attempt entirely.
  if (isRestricted(tab.url)) {
    await openFallback(dataUrl, tab.id);
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: OVERLAY_FILES,
    });
  } catch (err) {
    // Not on the restricted list but still un-injectable -- a sandboxed frame, a
    // strict CSP, a page mid-navigation. The capture is already in hand, so use it.
    console.warn('[NhakoCapture] injection blocked, using the editor window:', err);
    await openFallback(dataUrl, tab.id);
    return;
  }

  let cssText;
  try {
    cssText = await overlayStyles();
  } catch (err) {
    await reportFailure(tab.id, 'couldn’t load its own styles — try reloading the extension', String(err));
    return;
  }

  /* A start that throws inside the page (a bitmap that will not decode, a
   * zero-sized viewport) answers { ok: false } rather than rejecting. Treated
   * the same as no answer at all: the capture is in hand, so it goes to the
   * editor window instead of vanishing with nothing on screen. */
  let started;
  try {
    started = await chrome.tabs.sendMessage(tab.id, { type: 'nc:start', dataUrl, cssText }, { frameId: 0 });
  } catch (err) {
    started = { ok: false, error: String(err) };
  }
  if (!started?.ok) {
    console.warn('[NhakoCapture] overlay did not start, using the editor window:', started?.error);
    await openFallback(dataUrl, tab.id);
  }
}

chrome.action.onClicked.addListener(launch);

/* --- offscreen document -------------------------------------------------- */

/* Only one offscreen document may exist per extension, and createDocument
 * throws if one is already being created. Two rapid Ctrl+Shift+5 presses will
 * race here, so the in-flight promise is shared rather than re-entered. */
let creatingOffscreen = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* "Receiving end does not exist" is not a failure, it is a not-yet. It means
 * the message was never delivered -- so nothing happened on the other side and
 * a retry cannot double an effect. Every other error is real and is rethrown. */
function isDisconnected(err) {
  return /Receiving end does not exist|Could not establish connection|message port closed/i
    .test(String(err));
}

/* Waiting schedule for the readiness handshake, in ms before each attempt.
 * Front-loaded: the document is usually listening within a frame, and the long
 * tail only exists so a cold, contended worker still gets there. ~385ms total,
 * which is under the threshold where a user reads a delay as a hang. */
const OFFSCREEN_READY_BACKOFF = [0, 5, 10, 20, 50, 100, 200];

async function offscreenAnswers() {
  try {
    const res = await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, op: 'ping' });
    return res?.ok === true;
  } catch (err) {
    if (isDisconnected(err)) return false;
    throw err;
  }
}

/* THE COPY BUG LIVED HERE.
 *
 * createDocument's promise resolves when the document exists -- not when
 * offscreen.js has run and registered its onMessage listener. Sending into
 * that gap rejects with "Receiving end does not exist", which surfaced as
 * "Copy failed" on the first press and worked on the second, because by then
 * the listener was up. Nothing about the first press was actually wrong.
 *
 * So existence is no longer taken as readiness: the document is pinged until
 * it answers, and only then is a payload sent. */
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (contexts.length === 0) {
    if (!creatingOffscreen) {
      creatingOffscreen = chrome.offscreen
        .createDocument({
          url: OFFSCREEN_PATH,
          reasons: ['CLIPBOARD'],
          justification:
            'Write captured screenshots to the clipboard and mint blob URLs for ' +
            'downloads. Neither is possible in a service worker, and a content ' +
            'script on an http:// page is not a secure context.',
        })
        .catch((err) => {
          /* Lost a race with a caller getContexts could not see yet. A document
           * existing is the entire goal, so whoever created it did our job. */
          if (!/single offscreen document|already/i.test(String(err))) throw err;
        })
        .finally(() => {
          creatingOffscreen = null;
        });
    }
    await creatingOffscreen;
  }

  for (const wait of OFFSCREEN_READY_BACKOFF) {
    if (wait) await sleep(wait);
    if (await offscreenAnswers()) return;
  }
  throw new Error('offscreen document did not become ready');
}

/* --- letting the offscreen document go ------------------------------------
 *
 * An offscreen document holds the extension's process open for as long as it
 * exists, and every blob URL it has minted pins that whole image in memory
 * alongside it. Nothing needs it between captures, so it is closed once it is
 * genuinely idle: no blob outstanding, no download still waiting on one.
 *
 * Closing is safe precisely because ensureOffscreen already treats a missing
 * document as a not-yet rather than a failure -- the next capture pays one
 * handshake, which is the same cost it pays after Chromium evicts the worker.
 *
 * `outstandingBlobs` is a count rather than a set because the URLs themselves
 * live in the offscreen document; this side only needs to know whether any are
 * still owed a revoke. A URL the editor window never consumes leaves the count
 * above zero and the document open -- which is exactly the old behaviour, so
 * the worst case here is no worse than before. */
const OFFSCREEN_IDLE_MS = 30000;
let outstandingBlobs = 0;
let offscreenIdleTimer = null;

function scheduleOffscreenClose() {
  clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(async () => {
    // A Save As dialog can stay open indefinitely; its blob must outlive it.
    if (outstandingBlobs > 0 || pendingDownloads.size > 0) return;
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      });
      if (contexts.length) await chrome.offscreen.closeDocument();
    } catch {
      /* Already gone, or one is being created for the next capture. Either way
       * there is nothing here worth reporting. */
    }
  }, OFFSCREEN_IDLE_MS);
}

async function askOffscreen(op, payload) {
  let lastErr;
  /* Two passes, not more. The handshake in ensureOffscreen already absorbs a
   * slow start; this second pass exists only for the document being torn down
   * between the ping and the payload, which can happen once and then not
   * again. An unbounded retry would turn a dead offscreen document into a
   * hang instead of an error. */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await ensureOffscreen();
    try {
      const res = await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, op, ...payload });
      if (op === 'make-blob-url' && res?.ok) outstandingBlobs += 1;
      scheduleOffscreenClose();
      return res;
    } catch (err) {
      lastErr = err;
      if (!isDisconnected(err)) throw err;
    }
  }
  throw lastErr;
}

/* --- copy ---------------------------------------------------------------- */

async function copyImage(dataUrl) {
  return askOffscreen('copy-image', { dataUrl });
}

/* --- save ---------------------------------------------------------------- */

/* Named the way macOS names a screenshot -- "NhakoCapture 2026-09-29 at
 * 14.03.22.png" -- so it reads as a date and time at a glance and sorts
 * correctly in any file list. Dots, not colons, in the time: a colon is not a
 * legal filename character on Windows. */
function timestampedName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${NAME} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         ` at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.png`;
}

/* Blob URLs are revoked when their download settles, not on a timer -- the Save
 * As dialog can stay open indefinitely, and revoking underneath it would fail
 * the download. */
function revokeBlobUrl(url) {
  outstandingBlobs = Math.max(0, outstandingBlobs - 1);
  chrome.runtime
    .sendMessage({ target: OFFSCREEN_TARGET, op: 'revoke-blob-url', url })
    .catch(() => {
      /* Offscreen document already gone; the URL died with it. */
    })
    .finally(scheduleOffscreenClose);
}

const pendingDownloads = new Map(); // downloadId -> blob url

/* Chromium has reported a dismissed Save As dialog both as the interrupt
 * reason USER_CANCELED and as a plain "Download canceled". Matching only the
 * first turned the second into "Couldn't save that" -- an error message for
 * the user changing their mind. */
function isCancel(err) {
  return /USER_CANCEL|cancel/i.test(String(err?.message ?? err));
}

chrome.downloads.onChanged.addListener(({ id, state }) => {
  if (!state || !pendingDownloads.has(id)) return;
  if (state.current !== 'complete' && state.current !== 'interrupted') return;

  const url = pendingDownloads.get(id);
  pendingDownloads.delete(id);
  revokeBlobUrl(url);
});

async function saveImage(dataUrl, filename) {
  const made = await askOffscreen('make-blob-url', { dataUrl });
  if (!made?.ok) return made ?? { ok: false, error: 'offscreen did not respond' };

  try {
    // saveAs opens a real destination picker. v1 clicked a synthetic
    // <a download> instead, which never let the user choose a folder.
    const id = await chrome.downloads.download({
      url: made.url,
      filename: filename || timestampedName(),
      saveAs: true,
    });
    pendingDownloads.set(id, made.url);
    return { ok: true, downloadId: id };
  } catch (err) {
    revokeBlobUrl(made.url);
    // Cancelling the Save As dialog lands here and is not an error worth
    // shouting about.
    return { ok: false, error: String(err), cancelled: isCancel(err) };
  }
}

/* --- full page as PDF -----------------------------------------------------
 *
 * Hands the page to the browser's own print preview, where "Save as PDF" is
 * the default destination. A one-click route exists -- Page.printToPDF over
 * the DevTools protocol -- but it needs the `debugger` permission, which warns
 * at install that the extension can "read and change all your data on all
 * websites". That is too high a price for saving one click, on an extension
 * whose whole promise is that it touches nothing.
 *
 * The overlay has already torn itself down by the time this runs, so the
 * print preview renders the page as the user left it.
 */
async function savePdf(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.print(),
    });
    return { ok: true, via: 'print-dialog' };
  } catch (err) {
    await reportFailure(tabId, 'couldn’t open the print dialog for this page', String(err));
    return { ok: false, error: String(err) };
  }
}

/* --- message routing ----------------------------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Offscreen document messages are addressed by target; ignore them here or
  // both listeners would answer the same message.
  if (!msg || msg.target === OFFSCREEN_TARGET) return false;

  switch (msg.type) {
    case 'nc:copy':
      copyImage(msg.dataUrl).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: String(err) })
      );
      return true;

    case 'nc:save':
      saveImage(msg.dataUrl, msg.filename).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: String(err) })
      );
      return true;

    case 'nc:full-page-done':
      openFullPageEditor(msg, sender.tab?.id).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: String(err) })
      );
      return true;

    /* The editor window has the image decoded and no longer needs the URL.
     * Revoked on the editor's say-so rather than on a timer, because the
     * window can take arbitrarily long to open on a busy machine. */
    case 'nc:capture-consumed':
      revokeBlobUrl(msg.url);
      sendResponse({ ok: true });
      return false;

    case 'nc:progress':
      /* Fire-and-forget: progress that arrives late, or for a tab that has
       * gone, is not worth an error path. */
      (msg.done
        ? clearProgress(sender.tab?.id)
        : showProgress(sender.tab?.id, msg.index, msg.total)
      ).catch(() => {});
      sendResponse({ ok: true });
      return false;

    case 'nc:capture-tile':
      captureTile(sender.tab?.windowId, sender.tab?.id).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: String(err) })
      );
      return true;

    case 'nc:pdf':
      savePdf(sender.tab?.id).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: String(err) })
      );
      return true;

    default:
      return false;
  }
});
