/* NhakoCapture — direct clipboard write
 *
 * The offscreen document cannot put a real image on the clipboard.
 * navigator.clipboard.write requires a FOCUSED document, and an offscreen
 * document can never have focus -- so its rung 1 fails every time and every
 * copy lands on rung 2, the HTML-only fallback, which pastes into chat and
 * mail but not into an image editor or most "paste an image" boxes.
 *
 * The document the user just clicked Copy in IS focused and does hold a user
 * activation, so the write is attempted here first. It needs a secure context
 * (every https:// page, and the extension's own editor window); on a plain
 * http:// page navigator.clipboard does not exist and the caller falls back to
 * the offscreen route, which is exactly the case that route was built for.
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  if (!NC || NC.modules.clipboard) return;

  /* A write that neither resolves nor rejects -- a permission prompt nobody
   * answers, a page that has swallowed focus -- must not strand the user on
   * "Copying…". Past this the caller moves on to the offscreen route. */
  const WRITE_TIMEOUT = 3000;

  function supported() {
    return globalThis.isSecureContext === true &&
      typeof navigator?.clipboard?.write === 'function' &&
      typeof globalThis.ClipboardItem === 'function';
  }

  /* Resolves true when the PNG is on the clipboard, false when this route is
   * unavailable or refused. Never throws: a false is the caller's cue to try
   * the offscreen document instead.
   *
   * The blob is handed over as a PROMISE, and clipboard.write is called in the
   * same task as the click or keypress. Awaiting toBlob first would spend the
   * user activation on an encode that can take a few hundred milliseconds on a
   * large frame, and Chromium then refuses the write. */
  async function writePng(canvas) {
    if (!supported()) return false;
    const blob = new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
    });
    let timer;
    try {
      return await Promise.race([
        navigator.clipboard
          .write([new ClipboardItem({ 'image/png': blob })])
          .then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), WRITE_TIMEOUT); }),
      ]);
    } catch (err) {
      console.info('[NhakoCapture] direct clipboard write refused, using the fallback:', err);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  NC.define('clipboard', { writePng, supported });
})();
