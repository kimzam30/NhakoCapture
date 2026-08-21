/* NhakoCapture — fallback editor window
 *
 * For pages where a content script cannot run at all: brave://, chrome://, the
 * Web Store, the PDF viewer. The overlay cannot be mounted on them, so the same
 * capture is opened in an extension window and given the identical toolset.
 *
 * Everything here is composition. The stage, selection, annotation engine and
 * tool rail are the same modules the in-page overlay uses -- the only difference
 * is that the stage is fitted to a box inside this window rather than filling a
 * page's viewport, which is what `box` and `origin` exist for.
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  const geometry = NC.require('geometry');
  const opsModule = NC.require('ops');
  const stageModule = NC.require('stage');
  const selectionModule = NC.require('selection');
  const annotateModule = NC.require('annotate');
  const railModule = NC.require('rail');
  const toolbarModule = NC.require('toolbar');

  const STYLES = ['src/overlay/tokens.css', 'src/overlay/overlay.css'];

  function decode(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('captured bitmap failed to decode'));
      img.src = dataUrl;
    });
  }

  /* Fit the capture inside the window, preserving aspect and never enlarging
   * past 1:1 -- upscaling a screenshot only invents detail. The leftover space
   * is the letterbox, and its offset becomes the stage origin.
   *
   * The padding is asymmetric on purpose. This window opens with the whole
   * capture already framed, so without room reserved above and below the pill
   * and rail would have nowhere to sit and would fall back to their dimmed
   * overlaid state permanently -- the one case where that state would be the
   * norm rather than the exception. */
  const CHROME = { x: 24, top: 76, bottom: 88 };

  function fit(bitmap) {
    const availW = Math.max(64, window.innerWidth - CHROME.x * 2);
    const availH = Math.max(64, window.innerHeight - CHROME.top - CHROME.bottom);
    const scale = Math.min(availW / bitmap.naturalWidth, availH / bitmap.naturalHeight, 1);
    const width = Math.round(bitmap.naturalWidth * scale);
    const height = Math.round(bitmap.naturalHeight * scale);
    return {
      left: Math.round((window.innerWidth - width) / 2),
      top: Math.round(CHROME.top + (availH - height) / 2),
      width,
      height,
    };
  }

  const cleanup = {
    tasks: [],
    add(fn) { this.tasks.push(fn); },
    listen(t, type, fn, opts) { t.addEventListener(type, fn, opts); this.tasks.push(() => t.removeEventListener(type, fn, opts)); },
    runAll() { while (this.tasks.length) { try { this.tasks.pop()(); } catch { /* keep going */ } } },
  };

  async function main() {
    const stored = await chrome.storage.local.get(['capturedImage']);
    // One-shot: the capture is consumed so reopening this window cannot resurrect
    // a screenshot the user thought they had dismissed.
    await chrome.storage.local.remove(['capturedImage']);

    if (!stored.capturedImage) {
      document.getElementById('empty').style.display = 'flex';
      return;
    }

    const [bitmap, cssText] = await Promise.all([
      decode(stored.capturedImage),
      Promise.all(STYLES.map((p) => fetch(chrome.runtime.getURL(p)).then((r) => r.text())))
        .then((parts) => parts.join('\n')),
    ]);

    const box = fit(bitmap);
    const metrics = geometry.measure(
      bitmap.naturalWidth, bitmap.naturalHeight, box.width, box.height);

    const stage = stageModule.mount({ bitmap, metrics, cssText, box, clip: false }, cleanup);

    const ops = opsModule.create({ onChange: () => { annotate.paint(); rail.sync(); } });

    const selection = selectionModule.create({
      layer: stage.layer,
      view: stage.view,
      metrics,
      origin: stage.origin,
      setHole: stage.setHole,
      onChange: (rect, mode) => {
        stage.root.dataset.mode = mode;
        toolbar.avoid(rect);
        toolbar.setHint(mode === 'adjusting'
          ? 'Annotate, or drag the edges to adjust'
          : 'Drag to select an area');
        annotate.paint();
        rail.position(mode === 'adjusting' ? rect : null, toolbar.bottom() - stage.origin.y);
        rail.sync();
        if (!rect) { annotate.setTool(null); ops.clear(); }
      },
    });

    const annotate = annotateModule.create({
      layer: stage.layer,
      bitmap,
      metrics,
      ops,
      origin: stage.origin,
      getRect: () => selection.rect,
      onChange: () => {
        stage.root.dataset.tool = annotate.tool ?? '';
        annotate.paint();
        rail.sync();
      },
    });

    const rail = railModule.create({
      layer: stage.layer,
      view: stage.view,
      annotate,
      ops,
      actions: { copy: () => finish('copy'), save: () => finish('save') },
      /* The margin around the letterboxed capture, in stage-local coordinates. */
      bounds: {
        top: -box.top,
        bottom: window.innerHeight - box.top,
        left: -box.left,
        right: window.innerWidth - box.left,
      },
    });

    const toolbar = toolbarModule.create({
      layer: stage.layer,
      origin: stage.origin,
      // Lift the pill into the margin above the capture.
      top: -(CHROME.top - 16),
      actions: {
        /* No captureFullScreen: the whole capture IS the frame here, so
         * offering it would be a button that selects everything. No savePdf
         * either -- there is no live tab behind this window to print. */
        cancel: () => window.close(),
      },
    });

    rail.init();
    // The whole capture, framed, so the window is immediately useful.
    selection.selectAll();

    cleanup.listen(stage.root, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      if (annotate.tool && selection.rect && annotate.onPointerDown(e)) {
        e.preventDefault();
        stage.root.setPointerCapture(e.pointerId);
        return;
      }
      selection.onPointerDown(e);
    });
    cleanup.listen(stage.root, 'pointermove', (e) => {
      if (annotate.onPointerMove(e)) { e.preventDefault(); return; }
      selection.onPointerMove(e);
    });
    const up = (e) => {
      if (annotate.onPointerUp(e)) {
        try { stage.root.releasePointerCapture(e.pointerId); } catch { /* gone */ }
        return;
      }
      selection.onPointerUp(e);
    };
    cleanup.listen(stage.root, 'pointerup', up);
    cleanup.listen(stage.root, 'pointercancel', up);

    cleanup.listen(document, 'keydown', (event) => {
      if (annotate.editing) return;
      const mod = event.ctrlKey || event.metaKey;
      const stop = () => { event.preventDefault(); event.stopPropagation(); };

      if (event.key === 'Escape') {
        stop();
        // Same ladder as the overlay, except the last rung closes the window.
        if (annotate.tool) annotate.setTool(null);
        else if (selection.rect) selection.clear();
        else window.close();
        return;
      }
      if (mod && event.key.toLowerCase() === 'z') { stop(); event.shiftKey ? ops.redo() : ops.undo(); return; }
      if (mod && event.key.toLowerCase() === 'y') { stop(); ops.redo(); return; }
      if (mod && event.key.toLowerCase() === 'c') { stop(); finish('copy'); return; }
      if (mod && event.key.toLowerCase() === 's') { stop(); finish('save'); return; }
      if (mod) return;
      if (selection.rect && !event.altKey && rail.handleKey(event.key)) { stop(); return; }
      if (selection.onKeyDown(event)) stop();
    }, true);

    async function finish(action) {
      const canvas = annotate.compose();
      if (!canvas) return;
      toolbar.setHint(action === 'copy' ? 'Copying…' : 'Saving…');

      let res;
      try {
        res = await chrome.runtime.sendMessage({
          type: `nc:${action}`,
          dataUrl: canvas.toDataURL('image/png'),
        });
      } catch (err) {
        res = { ok: false, error: String(err) };
      }

      if (res?.ok) {
        toolbar.setHint(res.degraded ? (res.note ?? 'Copied (as HTML)')
                                     : (action === 'copy' ? 'Copied!' : 'Saved'));
        setTimeout(() => window.close(), res.degraded ? 1600 : 600);
        return;
      }
      if (res?.cancelled) { toolbar.setHint('Drag to select an area'); return; }
      toolbar.setHint(action === 'copy' ? 'Copy failed' : 'Save failed');
      console.error('[NhakoCapture]', action, 'failed:', res?.error);
    }

    /* Resizing the window changes the fit, and every coordinate is measured
     * against it. Remount rather than let the frame drift off the image. */
    let resizeTimer = null;
    cleanup.listen(window, 'resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => window.location.reload(), 200);
    });

    stage.root.focus({ preventScroll: true });
  }

  main().catch((err) => {
    console.error('[NhakoCapture] fallback editor failed:', err);
    document.getElementById('empty').style.display = 'flex';
  });
})();
