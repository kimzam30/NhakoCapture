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
 * can say so rather than implying a clean copy. */
function writeViaCopyEvent(dataUrl) {
  return new Promise((resolve, reject) => {
    const onCopy = (event) => {
      event.preventDefault();
      event.clipboardData.setData(
        'text/html',
        `<img src="${dataUrl}" alt="Screenshot">`
      );
    };
    document.addEventListener('copy', onCopy, { once: true });
    try {
      if (document.execCommand('copy')) resolve('copy-event-html');
      else reject(new Error('execCommand("copy") returned false'));
    } catch (err) {
      reject(err);
    } finally {
      document.removeEventListener('copy', onCopy);
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
