/* NhakoCapture — overlay entry point
 *
 * Owns the overlay lifecycle: receives the bitmap the background captured before
 * we existed, measures it, mounts the stage, and wires selection, pill and
 * keyboard together.
 *
 * The teardown discipline here is the fix for v1's two worst bugs. In v1 the
 * keydown handler sat OUTSIDE the `if (!document.getElementById(...))` block
 * that declared `overlay` and `selectionBox`, so it closed over nothing:
 * pressing Escape threw ReferenceError every single time, and because it was
 * outside the guard it registered another dead listener on every injection.
 * Here every listener is registered through cleanup.listen(), so destroy()
 * cannot drift out of sync with what start() set up.
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  if (!NC) return;

  const geometry = NC.require('geometry');
  const stageModule = NC.require('stage');
  const selectionModule = NC.require('selection');
  const toolbarModule = NC.require('toolbar');

  if (NC.reinjected) {
    NC.reinjected = false;
    try {
      NC.destroy?.();
    } catch (err) {
      console.warn('[NhakoCapture] teardown before relaunch failed:', err);
    }
  }

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

  async function start({ dataUrl, cssText }) {
    if (session) destroy();

    const bitmap = await decode(dataUrl);

    /* Measured from the bitmap actually received rather than read from
     * devicePixelRatio: browser zoom lands on fractional ratios and the
     * compositor rounds, so these are the only trustworthy numbers. */
    const metrics = geometry.measure(
      bitmap.naturalWidth,
      bitmap.naturalHeight,
      window.innerWidth,
      window.innerHeight
    );

    const cleanup = createCleanup();
    session = { bitmap, metrics, cleanup };

    /* Scroll lock. The backdrop is a still image, so a scroll underneath it
     * would silently desync the overlay from the page it depicts. */
    const scroll = { x: window.scrollX, y: window.scrollY };
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    cleanup.add(() => {
      document.documentElement.style.overflow = prevOverflow;
      window.scrollTo(scroll.x, scroll.y);
    });

    /* Focus is restored to whatever had it, so dismissing the overlay puts the
     * user back exactly where they were. */
    const previouslyFocused = document.activeElement;
    cleanup.add(() => {
      try { previouslyFocused?.focus?.(); } catch { /* element is gone */ }
    });

    const stage = stageModule.mount({ bitmap, metrics, cssText }, cleanup);
    session.stage = stage;

    const selection = selectionModule.create({
      layer: stage.layer,
      view: stage.view,
      metrics,
      setHole: stage.setHole,
      onChange: (rect, mode) => {
        stage.root.dataset.mode = mode;
        toolbar.avoid(rect);
        toolbar.setHint(
          mode === 'adjusting'
            ? 'Drag the edges to adjust'
            : 'Drag to select an area'
        );
      },
    });
    session.selection = selection;

    const toolbar = toolbarModule.create({
      layer: stage.layer,
      actions: {
        captureFullScreen: () => selection.selectAll(),
        /* savePdf is deliberately absent until Phase 5 builds it -- the pill
         * renders only the actions that exist. */
        cancel: () => destroy(),
      },
    });
    session.toolbar = toolbar;

    cleanup.listen(stage.root, 'pointerdown', selection.onPointerDown);
    cleanup.listen(stage.root, 'pointermove', selection.onPointerMove);
    cleanup.listen(stage.root, 'pointerup', selection.onPointerUp);
    cleanup.listen(stage.root, 'pointercancel', selection.onPointerUp);

    /* Capture phase, on the document: the page must not see these keys, and a
     * page that stops propagation on its own handlers must not be able to
     * swallow our Escape. */
    cleanup.listen(document, 'keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        /* One step back, not straight out: from an adjusted frame Escape
         * returns to a clean slate, and only then exits. */
        if (selection.rect) selection.clear();
        else destroy();
        return;
      }
      if (selection.onKeyDown(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);

    /* The scroll lock stops the document scrolling, but a wheel over a nested
     * scroller would still move content out from under a frozen backdrop. */
    cleanup.listen(stage.root, 'wheel', (e) => e.preventDefault(), { passive: false });

    /* A viewport resize invalidates the bitmap: it depicts a viewport that no
     * longer exists, and every coordinate is measured against it. Rather than
     * show a stale capture, stand down.
     *
     * But only on a REAL size change. Browsers fire resize for things that do
     * not change the viewport at all -- pinch zoom, a docking devtools panel, a
     * mobile URL bar sliding away, and a window being sized during startup.
     * Tearing down the overlay on those would look like it had crashed. */
    cleanup.listen(window, 'resize', () => {
      if (window.innerWidth === metrics.cssWidth &&
          window.innerHeight === metrics.cssHeight) return;
      destroy();
    });

    stage.root.focus({ preventScroll: true });

    return { metrics };
  }

  function destroy() {
    if (!session) return;
    session.cleanup.runAll();
    session = null;
    NC.destroy = null;
  }

  NC.define('overlay', {
    start,
    destroy,
    metrics: () => session?.metrics,
    get session() { return session; },
  });

  /* Registered once for the lifetime of the isolated world, outside start(), so
   * repeated invocations cannot stack handlers. */
  if (!NC.modules.__listening) {
    NC.define('__listening', true);
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== 'nc:start') return false;
      start(msg).then(
        (result) => sendResponse({ ok: true, ...result }),
        (err) => {
          console.error('[NhakoCapture] start failed:', err);
          destroy();
          sendResponse({ ok: false, error: String(err) });
        }
      );
      return true;
    });
  }
})();
