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
  'src/engine/ops.js',
  'src/engine/render.js',
  'src/overlay/stage.js',
  'src/overlay/selection.js',
  'src/overlay/annotate.js',
  'src/overlay/rail.js',
  'src/overlay/toolbar.js',
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

/* --- user-visible failure ------------------------------------------------ */

/* No notifications permission: a red badge on our own action costs nothing and
 * cannot be blocked by the page. Phase 6 (T17) adds the in-overlay toast for
 * the cases where an overlay does exist to show it in. */
async function reportFailure(tabId, short, detail) {
  console.warn('[NhakoCapture]', short, detail ?? '');
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#ff453a' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setTitle({
      tabId,
      title: `Nhako Capture — ${short}${detail ? `\n${detail}` : ''}`,
    });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      chrome.action.setTitle({ tabId, title: 'Nhako Capture (Ctrl+Shift+5)' })
        .catch(() => {});
    }, 5000);
  } catch {
    /* Tab closed while we were reporting. Nothing left to report to. */
  }
}

/* --- launch -------------------------------------------------------------- */

async function captureViewport(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

/* Pages where a content script cannot run get the fallback editor window
 * instead. Sized to the capture where possible so the image is not letterboxed
 * into a strip, and clamped so it cannot open larger than the display. */
const FALLBACK_MIN = { width: 720, height: 520 };
const FALLBACK_MAX = { width: 1400, height: 900 };

async function fallbackWindowSize(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const CHROME = { width: 32, height: 96 }; // window frame + our toolbars
    const size = {
      width: Math.round(Math.min(Math.max(bmp.width + CHROME.width, FALLBACK_MIN.width), FALLBACK_MAX.width)),
      height: Math.round(Math.min(Math.max(bmp.height + CHROME.height, FALLBACK_MIN.height), FALLBACK_MAX.height)),
    };
    bmp.close();
    return size;
  } catch {
    return { width: 1100, height: 760 };
  }
}

async function openFallback(dataUrl, tabId) {
  try {
    await chrome.storage.local.set({ capturedImage: dataUrl });
    const size = await fallbackWindowSize(dataUrl);
    await chrome.windows.create({
      url: 'src/fallback/editor.html',
      type: 'popup',
      focused: true,
      ...size,
    });
    return true;
  } catch (err) {
    await reportFailure(tabId, 'could not open the editor', String(err));
    return false;
  }
}

async function launch(tab) {
  if (!tab?.id) return;

  // Clear any leftover failure badge from a previous attempt.
  chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {});

  /* Capture first, always -- before any UI of ours exists, and before deciding
   * where the capture is going to be edited. */
  let dataUrl;
  try {
    dataUrl = await captureViewport(tab.windowId);
  } catch (err) {
    await reportFailure(
      tab.id,
      'this page cannot be captured',
      'Browser pages and the Web Store are off-limits to extensions.'
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
    await reportFailure(tab.id, 'overlay styles failed to load', String(err));
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'nc:start', dataUrl, cssText });
  } catch (err) {
    console.warn('[NhakoCapture] overlay did not answer, using the editor window:', err);
    await openFallback(dataUrl, tab.id);
  }
}

chrome.action.onClicked.addListener(launch);

/* --- offscreen document -------------------------------------------------- */

/* Only one offscreen document may exist per extension, and createDocument
 * throws if one is already being created. Two rapid Ctrl+Shift+5 presses will
 * race here, so the in-flight promise is shared rather than re-entered. */
let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;

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
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function askOffscreen(op, payload) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, op, ...payload });
}

/* --- copy ---------------------------------------------------------------- */

async function copyImage(dataUrl) {
  return askOffscreen('copy-image', { dataUrl });
}

/* --- save ---------------------------------------------------------------- */

function timestampedName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Nhako_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.png`;
}

/* Blob URLs are revoked when their download settles, not on a timer -- the Save
 * As dialog can stay open indefinitely, and revoking underneath it would fail
 * the download. */
const pendingDownloads = new Map(); // downloadId -> blob url

chrome.downloads.onChanged.addListener(({ id, state }) => {
  if (!state || !pendingDownloads.has(id)) return;
  if (state.current !== 'complete' && state.current !== 'interrupted') return;

  const url = pendingDownloads.get(id);
  pendingDownloads.delete(id);
  chrome.runtime
    .sendMessage({ target: OFFSCREEN_TARGET, op: 'revoke-blob-url', url })
    .catch(() => {
      /* Offscreen document already gone; the URL died with it. */
    });
});

async function saveImage(dataUrl, filename) {
  const made = await askOffscreen('make-blob-url', { dataUrl });
  if (!made?.ok) return made ?? { ok: false, error: 'offscreen did not respond' };

  try {
    // saveAs opens a real destination picker. v1 clicked a synthetic <a download>
    // instead, which is why "Save Button after ss, no popup for destination" is
    // an open bug in todo.md.
    const id = await chrome.downloads.download({
      url: made.url,
      filename: filename || timestampedName(),
      saveAs: true,
    });
    pendingDownloads.set(id, made.url);
    return { ok: true, downloadId: id };
  } catch (err) {
    chrome.runtime
      .sendMessage({ target: OFFSCREEN_TARGET, op: 'revoke-blob-url', url: made.url })
      .catch(() => {});
    // Cancelling the Save As dialog lands here and is not an error worth
    // shouting about.
    return { ok: false, error: String(err), cancelled: /USER_CANCELED/i.test(String(err)) };
  }
}

/* --- full page as PDF -----------------------------------------------------
 *
 * Opera's "Save page as PDF". Chromium exposes Page.printToPDF only through the
 * DevTools protocol, so this attaches the debugger for the second or so the
 * render takes and detaches immediately. That surfaces Chromium's "started
 * debugging this browser" infobar for the duration -- accepted knowingly as the
 * price of true parity, and the reason detach is in a finally block.
 *
 * Attach fails when DevTools is already open on the tab, so there is a second
 * route: window.print(), which lands the user in Brave's own print preview with
 * "Save as PDF" preselected. Two clicks instead of one, no banner.
 */
async function pdfViaDebugger(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    await chrome.debugger.sendCommand(target, 'Page.enable');
    const result = await chrome.debugger.sendCommand(target, 'Page.printToPDF', {
      printBackground: true,
      transferMode: 'ReturnAsBase64',
    });
    if (!result?.data) throw new Error('printToPDF returned no data');
    return result.data;
  } finally {
    // Detach even on failure: a stranded attachment leaves the infobar up for
    // the life of the tab.
    try { await chrome.debugger.detach(target); } catch { /* already gone */ }
  }
}

async function pdfViaPrintDialog(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.print(),
  });
}

function timestampedPdfName() {
  return timestampedName().replace(/\.png$/, '.pdf');
}

async function savePdf(tabId) {
  let base64;
  try {
    base64 = await pdfViaDebugger(tabId);
  } catch (err) {
    console.warn('[NhakoCapture] debugger route unavailable, falling back:', err);
    try {
      await pdfViaPrintDialog(tabId);
      return { ok: true, via: 'print-dialog' };
    } catch (fallbackErr) {
      await reportFailure(tabId, 'could not produce a PDF', String(fallbackErr));
      return { ok: false, error: String(fallbackErr) };
    }
  }

  const made = await askOffscreen('make-blob-url', {
    dataUrl: `data:application/pdf;base64,${base64}`,
  });
  if (!made?.ok) return made ?? { ok: false, error: 'offscreen did not respond' };

  try {
    const id = await chrome.downloads.download({
      url: made.url,
      filename: timestampedPdfName(),
      saveAs: true,
    });
    pendingDownloads.set(id, made.url);
    return { ok: true, via: 'debugger', downloadId: id };
  } catch (err) {
    chrome.runtime
      .sendMessage({ target: OFFSCREEN_TARGET, op: 'revoke-blob-url', url: made.url })
      .catch(() => {});
    return { ok: false, error: String(err), cancelled: /USER_CANCELED/i.test(String(err)) };
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

    case 'nc:pdf':
      savePdf(sender.tab?.id).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: String(err) })
      );
      return true;

    case 'nc:failed':
      reportFailure(sender.tab?.id, msg.short ?? 'something went wrong', msg.detail);
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});
