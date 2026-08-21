/* NhakoCapture — overlay entry point
 *
 * Owns the overlay lifecycle: receives the bitmap the background captured
 * before we existed, measures it, and hands off to the renderer.
 *
 * Phase 2 establishes the lifecycle only. render() is a seam that Phase 3 (T4)
 * fills with the shadow host, frozen backdrop and scrim; everything around it
 * -- handoff, measurement, re-injection, teardown -- is final.
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  if (!NC) return;

  const geometry = NC.require('geometry');

  /* Re-entry. Pressing Ctrl+Shift+5 while an overlay is already up re-runs every
   * injected file. Without this, a second overlay stacks on the first and the
   * first one's listeners are orphaned -- which is exactly the leak v1 has, one
   * abandoned keydown handler per invocation. */
  if (NC.reinjected) {
    NC.reinjected = false;
    try {
      NC.destroy?.();
    } catch (err) {
      console.warn('[NhakoCapture] teardown before relaunch failed:', err);
    }
  }

  /* Everything that must be undone on teardown is registered here, so destroy()
   * cannot drift out of sync with what start() set up. */
  function createCleanup() {
    const tasks = [];
    return {
      add(fn) { tasks.push(fn); },
      listen(target, type, handler, opts) {
        target.addEventListener(type, handler, opts);
        tasks.push(() => target.removeEventListener(type, handler, opts));
      },
      runAll() {
        while (tasks.length) {
          const fn = tasks.pop();
          try { fn(); } catch (err) {
            console.warn('[NhakoCapture] cleanup step failed:', err);
          }
        }
      },
    };
  }

  let session = null;

  function decode(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('captured bitmap failed to decode'));
      img.src = dataUrl;
    });
  }

  async function start(dataUrl) {
    if (session) destroy();

    const bitmap = await decode(dataUrl);

    /* Measured from the bitmap we actually received rather than read from
     * devicePixelRatio: browser zoom lands on fractional ratios and the
     * compositor rounds, so the real numbers are the only trustworthy ones. */
    const metrics = geometry.measure(
      bitmap.naturalWidth,
      bitmap.naturalHeight,
      window.innerWidth,
      window.innerHeight
    );

    const cleanup = createCleanup();
    session = { bitmap, metrics, cleanup };

    /* Scroll lock. The backdrop is a still image, so any scroll underneath it
     * would silently desync the overlay from the page it depicts. */
    const scroll = { x: window.scrollX, y: window.scrollY };
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    cleanup.add(() => {
      document.documentElement.style.overflow = prevOverflow;
      window.scrollTo(scroll.x, scroll.y);
    });

    NC.destroy = destroy;
    render(session, cleanup);
    return metrics;
  }

  /* Phase 3 (T4) replaces this body with the shadow host, backdrop and scrim.
   * The signature is the contract. */
  function render(_session, _cleanup) {
    console.info(
      '[NhakoCapture] captured %d×%d device px from a %d×%d viewport ' +
      '(scaleX %s, scaleY %s) — overlay UI lands in Phase 3',
      _session.metrics.bitmapWidth, _session.metrics.bitmapHeight,
      _session.metrics.cssWidth, _session.metrics.cssHeight,
      _session.metrics.scaleX.toFixed(4), _session.metrics.scaleY.toFixed(4)
    );
  }

  function destroy() {
    if (!session) return;
    session.cleanup.runAll();
    session = null;
    NC.destroy = null;
  }

  NC.define('overlay', { start, destroy, get session() { return session; } });

  /* One listener for the lifetime of the isolated world -- registered once,
   * outside start(), so repeated invocations cannot stack handlers. */
  if (!NC.modules.__listening) {
    NC.define('__listening', true);
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== 'nc:start') return false;
      start(msg.dataUrl).then(
        (metrics) => sendResponse({ ok: true, metrics }),
        (err) => {
          console.error('[NhakoCapture] start failed:', err);
          sendResponse({ ok: false, error: String(err) });
        }
      );
      return true;
    });
  }
})();
