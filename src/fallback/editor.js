/* NhakoCapture — fallback editor window
 *
 * For pages where a content script cannot run at all: chrome://, the
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
  const clipboard = NC.require('clipboard');

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

  /* The decoded capture, held for the life of the window.
   *
   * This is what makes a resize survivable. The capture is consumed from
   * storage the moment it arrives -- deliberately, so reopening this window
   * cannot resurrect a screenshot the user dismissed -- which means there is
   * nothing left to re-read afterwards. Reloading the window to re-fit, which
   * is what a resize used to do, therefore threw the capture away and left the
   * user looking at the empty state after nothing worse than dragging a
   * corner. Everything the fit depends on is a pure function of this bitmap
   * and the window size, so a remount is all a resize ever needed. */
  let capture = null;          // { bitmap, cssText, capped }

  /* Created once and kept across remounts, so marks survive a resize too.
   * Fixing the capture loss while still silently discarding annotations would
   * only be a smaller version of the same bug. */
  let ops = null;

  /* The fit currently in force. A remount compares against it to learn how far
   * the capture scaled, which is what the ops and the frame are rescaled by. */
  let currentBox = null;

  /* One level of indirection so ops can outlive the modules that listen to it:
   * opsModule.create takes its onChange once, but annotate and rail are rebuilt
   * on every remount. */
  const handlers = { change: () => {} };

  function showEmpty() {
    document.getElementById('empty').style.display = 'flex';
  }

  async function main() {
    const KEYS = ['capturedImage', 'captureBlobUrl', 'captureCapped'];
    const stored = await chrome.storage.local.get(KEYS);
    // One-shot: the capture is consumed so reopening this window cannot resurrect
    // a screenshot the user thought they had dismissed.
    await chrome.storage.local.remove(KEYS);

    /* Two populations arrive here now. A restricted-page capture is a data URL
     * held in storage; a full-page capture is a blob URL, because the stitched
     * image would not fit in storage's quota. Everything downstream is
     * identical -- an <img> does not care which kind of URL it was given. */
    const source = stored.capturedImage ?? stored.captureBlobUrl;
    if (!source) {
      showEmpty();
      return;
    }

    const [bitmap, cssText] = await Promise.all([
      decode(source),
      Promise.all(STYLES.map((p) => fetch(chrome.runtime.getURL(p)).then((r) => r.text())))
        .then((parts) => parts.join('\n')),
    ]);

    /* Now, and not a moment earlier: the blob is what the <img> was decoded
     * from, and revoking before that lands would leave the window empty. It is
     * revoked in the offscreen document that created it -- a blob URL cannot
     * be revoked from anywhere else -- and dropping it promptly matters
     * because it pins the whole stitched PNG in memory until it goes. */
    if (stored.captureBlobUrl) {
      chrome.runtime
        .sendMessage({ type: 'nc:capture-consumed', url: stored.captureBlobUrl })
        .catch(() => { /* worker asleep; the URL dies with the document */ });
    }

    capture = { bitmap, cssText, capped: stored.captureCapped === true };
    ops = opsModule.create({ onChange: () => handlers.change() });
    mount();
  }

  /* Builds the whole editor against the current window size. Safe to run again:
   * `cleanup.runAll()` takes the previous mount down first, and stage.mount
   * removes any host that somehow survived it.
   *
   * `carry` is the state that outlives a remount -- the frame, and the scale
   * factor everything recorded in the old fit has to be multiplied by. */
  function mount(carry = null) {
    const { bitmap, cssText, capped } = capture;

    const box = fit(bitmap);
    const scale = carry && currentBox ? box.width / currentBox.width : 1;
    currentBox = box;

    /* Nothing may reach the modules from the mount being replaced -- their DOM
     * is already gone. Re-pointed at the new ones at the end of this function. */
    handlers.change = () => {};
    if (carry) ops.remap((op) => opsModule.scaleOp(op, scale));

    const metrics = geometry.measure(
      bitmap.naturalWidth, bitmap.naturalHeight, box.width, box.height);

    const stage = stageModule.mount({ bitmap, metrics, cssText, box, clip: false }, cleanup);

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
          ? 'Mark it up, or drag the edges to adjust'
          : 'Drag over anything to capture it');
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
        /* No captureVisiblePage: the whole capture IS the frame here, so
         * offering it would be a button that selects everything. No savePdf
         * either -- there is no live tab behind this window to print. */
        cancel: () => window.close(),
      },
    });

    handlers.change = () => { annotate.paint(); rail.sync(); };

    rail.init();
    /* Restore the frame the user had, scaled into the new fit; on a first
     * mount there is none, so frame the whole capture and make the window
     * immediately useful. */
    if (!carry) {
      selection.selectAll();
    } else if (carry.rect) {
      const r = carry.rect;
      selection.set({
        x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale,
      });
    }
    /* A remount with no frame keeps having no frame -- selection starts empty,
     * so re-framing everything would undo a deliberate Escape. */
    if (carry?.tool) annotate.setTool(carry.tool);

    /* A capped capture is not the page. Say so, in the pill, before the user
     * has done anything with it -- and keep saying it, because `selectAll`
     * above has already overwritten the hint and the first copy will overwrite
     * it again.
     *
     * The height quoted is the one this image actually has, not the constant
     * it was clamped against: the last tile can stop a little short, and
     * quoting a round number the image does not match would be a smaller lie
     * of the same kind this notice exists to prevent.
     *
     * Deferred a frame so the live region is in the tree before its text
     * changes, which is what makes it announce. */
    if (capped) {
      requestAnimationFrame(() => {
        toolbar.setNotice(
          `Cut off at ${bitmap.naturalHeight}px — the page keeps going`
        );
      });
    }

    cleanup.listen(stage.root, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      // Handles always resize, tool or no tool -- as in the page overlay.
      const onHandle = e.composedPath()[0]?.classList?.contains('nc-handle');
      if (!onHandle && annotate.tool && selection.rect && annotate.onPointerDown(e)) {
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

    let finishing = false;

    async function finish(action) {
      if (finishing) return;
      const canvas = annotate.compose();
      if (!canvas) {
        toolbar.setHint('Drag over something first, then copy or save it');
        return;
      }
      finishing = true;
      toolbar.setHint(action === 'copy' ? 'Copying…' : 'Saving…', 'busy');

      let res;
      try {
        /* This window is an extension page: a secure context, and focused
         * because the user just clicked in it -- so it can write a real PNG
         * itself, which the offscreen document never can. */
        if (action === 'copy' && await clipboard.writePng(canvas)) {
          res = { ok: true, via: 'page' };
        } else {
          res = await chrome.runtime.sendMessage({
            type: `nc:${action}`,
            dataUrl: canvas.toDataURL('image/png'),
          });
        }
      } catch (err) {
        res = { ok: false, error: String(err) };
      }
      finishing = false;

      if (res?.ok) {
        /* Same reasoning as the overlay: the degraded result goes to the
         * notice, which survives the narrow-window collapse that hides the
         * hint, and this window closes 1.6s later. */
        if (res.degraded) toolbar.setNotice('Copied as HTML');
        toolbar.setHint(res.degraded ? (res.note ?? 'Copied (as HTML)')
                                     : (action === 'copy' ? 'Copied. Paste it anywhere' : 'Saved'),
                        'success');
        /* The same shutter flash and fade the page overlay gives. */
        stage.flash(selection.rect);
        const total = res.degraded ? 1600 : 650;
        setTimeout(() => stage.leave(), total - 200);
        setTimeout(() => window.close(), total);
        return;
      }
      if (res?.cancelled) { toolbar.setHint('Mark it up, or drag the edges to adjust'); return; }
      toolbar.setHint(action === 'copy' ? 'Couldn’t copy that. Try again?'
                                        : 'Couldn’t save that. Try again?', 'error');
      console.error('[NhakoCapture]', action, 'failed:', res?.error);
    }

    /* Resizing the window changes the fit, and every coordinate is measured
     * against it, so the editor has to be rebuilt.
     *
     * Rebuilt -- NOT reloaded. This reloaded the window, which is the one thing
     * it could not do: the capture is consumed from storage on open and the
     * blob URL is revoked immediately after decoding, so the reloaded document
     * found nothing and showed the empty state. Dragging the corner of the
     * window destroyed the screenshot. The bitmap is still in memory here, and
     * the frame and the marks come with it. */
    let resizeTimer = null;
    cleanup.add(() => clearTimeout(resizeTimer));
    cleanup.listen(window, 'resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const carry = { rect: selection.rect, tool: annotate.tool };
        cleanup.runAll();
        try {
          mount(carry);
        } catch (err) {
          /* Nothing is left listening at this point, so a throw here would
           * leave a blank window with no way out. */
          console.error('[NhakoCapture] remount after resize failed:', err);
          showEmpty();
        }
      }, 200);
    });

    stage.root.focus({ preventScroll: true });
  }

  main().catch((err) => {
    console.error('[NhakoCapture] fallback editor failed:', err);
    showEmpty();
  });
})();
