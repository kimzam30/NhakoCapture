/* NhakoCapture — offscreen worker
 *
 * Two jobs the rest of the extension cannot do for itself:
 *
 *   1. Write an image to the clipboard. A content script cannot be relied on
 *      for this: navigator.clipboard only exists in a secure context, so on any
 *      plain http:// page it is simply undefined. The service worker has no DOM
 *      and therefore no Clipboard API at all.
 *   2. Mint blob: URLs. URL.createObjectURL does not exist in a service worker,
 *      and chrome.downloads.download will not accept a data: URL.
 */
'use strict';

const TARGET = 'nc-offscreen';

/* Blob URLs pin the whole PNG in memory until revoked, so every one handed out
 * is tracked and released when its download settles. */
const liveUrls = new Set();

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

/* Rung 1: a real image/png clipboard flavour. This is the one that lets you
 * paste into an image editor. */
async function writeViaClipboardApi(blob) {
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  return 'clipboard-api';
}

/* Rung 2: the copy-event route. Puts the image on the clipboard as HTML, which
 * pastes correctly into rich-text targets -- mail, chat, docs -- but not into
 * an image editor. Degraded, not equivalent, and reported as such so the caller
 * can say so rather than implying a clean copy.
 *
 * This rung had never once caught a rung-1 failure. execCommand('copy') copies
 * THE SELECTION, and this document has never had one -- so Chrome returned
 * false without ever firing a copy event, and the listener below was dead code.
 * The holder exists to give the command something to act on. The listener then
 * replaces the markup the browser would have derived from it with markup we
 * control, so the pasted <img> is exactly one tag rather than whatever the
 * serializer makes of a contenteditable div.
 */
function writeViaCopyEvent(dataUrl) {
  return new Promise((resolve, reject) => {
    const holder = document.createElement('div');
    holder.contentEditable = 'true';
    holder.setAttribute('aria-hidden', 'true');
    /* Moved off-screen, not hidden. display:none and visibility:hidden both
     * make a node unselectable, which would put us straight back to the empty
     * selection this function exists to fix. */
    holder.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;' +
      'overflow:hidden;opacity:0';

    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = 'Screenshot';
    holder.appendChild(img);
    document.body.appendChild(holder);

    const selection = window.getSelection();
    const saved = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;

    let fired = false;
    const onCopy = (event) => {
      fired = true;
      event.preventDefault();
      event.clipboardData.setData(
        'text/html',
        `<img src="${dataUrl}" alt="Screenshot">`
      );
    };
    document.addEventListener('copy', onCopy);

    try {
      holder.focus();
      const range = document.createRange();
      range.selectNodeContents(holder);
      selection.removeAllRanges();
      selection.addRange(range);

      const accepted = document.execCommand('copy');
      /* Both conditions, deliberately. execCommand can report success on a
       * command the platform quietly declined, and resolving on that would
       * report a copy that never reached the clipboard -- the same class of
       * lie this whole task exists to remove, just in the other direction. */
      if (accepted && fired) resolve('copy-event-html');
      else if (accepted) reject(new Error('copy event never fired'));
      else reject(new Error('execCommand("copy") returned false'));
    } catch (err) {
      reject(err);
    } finally {
      document.removeEventListener('copy', onCopy);
      selection.removeAllRanges();
      if (saved) selection.addRange(saved);
      holder.remove();
    }
  });
}

async function copyImage(dataUrl) {
  const blob = await dataUrlToBlob(dataUrl);

  try {
    return { ok: true, via: await writeViaClipboardApi(blob) };
  } catch (apiErr) {
    try {
      return {
        ok: true,
        via: await writeViaCopyEvent(dataUrl),
        degraded: true,
        note: 'Pasted as HTML — works in chat and documents, not image editors.',
        apiError: String(apiErr),
      };
    } catch (evtErr) {
      return {
        ok: false,
        error: `clipboard unavailable (api: ${apiErr}; copy-event: ${evtErr})`,
      };
    }
  }
}

async function makeBlobUrl(dataUrl) {
  const blob = await dataUrlToBlob(dataUrl);
  const url = URL.createObjectURL(blob);
  liveUrls.add(url);
  return { ok: true, url, size: blob.size };
}

function revokeBlobUrl(url) {
  if (liveUrls.delete(url)) URL.revokeObjectURL(url);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== TARGET) return false;

  (async () => {
    try {
      switch (msg.op) {
        /* The readiness handshake. createDocument resolving tells the service
         * worker this document EXISTS; only a reply to this tells it the
         * listener below is actually attached. Cheap on purpose -- it is sent
         * on a retry loop and must never be the slow part. */
        case 'ping':
          sendResponse({ ok: true });
          break;
        case 'copy-image':
          sendResponse(await copyImage(msg.dataUrl));
          break;
        case 'make-blob-url':
          sendResponse(await makeBlobUrl(msg.dataUrl));
          break;
        case 'revoke-blob-url':
          sendResponse(revokeBlobUrl(msg.url));
          break;
        default:
          sendResponse({ ok: false, error: `unknown op "${msg.op}"` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  return true; // response is async
});
