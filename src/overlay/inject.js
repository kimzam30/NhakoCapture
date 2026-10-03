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
  const opsModule = NC.require('ops');
  const stageModule = NC.require('stage');
  const selectionModule = NC.require('selection');
  const annotateModule = NC.require('annotate');
  const railModule = NC.require('rail');
  const toolbarModule = NC.require('toolbar');
  const fullpageModule = NC.require('fullpage');
  const stitchModule = NC.require('stitch');
  const clipboard = NC.require('clipboard');

  /* A live region that is NOT inside the overlay.
   *
   * The pill's hint cannot carry announcements during a full-page capture: the
   * overlay is hidden for the duration, and a hidden subtree is out of the
   * accessibility tree entirely. Worse, `run()` executes synchronously up to
   * its first await, so setting the hint and hiding the host happen in the same
   * task -- the text is populated and removed before any screen reader could
   * observe it. The announcement simply never happened.
   *
   * This element lives in the page instead, and paints nothing: clipped to
   * nothing at 1x1, so captureVisibleTab has nothing to photograph. That is
   * exactly the property the brief named when it left this gap open --
   * "a channel that is both announced and un-photographable".
   *
   * Inline and !important throughout, because it sits in a page whose own CSS
   * we do not control and must not be made visible by it. */
  /* How long the announcer outlives the overlay. The last thing it says is
   * usually said AT teardown -- "Full page captured, opening the editor" --
   * and a live region removed in the same task as its final message is a
   * message nobody hears. It paints nothing, so lingering costs the page
   * nothing but the few seconds an assistive technology needs to read it. */
  const ANNOUNCER_LINGER = 4000;
  const ANNOUNCER_ID = 'nhako-capture-announcer';

  function createAnnouncer(cleanup) {
    /* A lingering announcer from a previous session must not stack. */
    document.getElementById(ANNOUNCER_ID)?.remove();

    const el = document.createElement('div');
    el.id = ANNOUNCER_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:1px', 'height:1px',
      'margin:-1px', 'padding:0', 'border:0', 'overflow:hidden',
      'clip-path:inset(50%)', 'white-space:nowrap', 'pointer-events:none',
      'z-index:-1', 'contain:strict',
    ].map((d) => d + ' !important').join(';');
    document.documentElement.appendChild(el);
    cleanup.add(() => {
      // Detached on a timer rather than at teardown -- see ANNOUNCER_LINGER.
      setTimeout(() => el.remove(), ANNOUNCER_LINGER);
    });

    return {
      element: el,
      /* Cleared first: an assistive technology will not re-announce a live
       * region whose text has not changed, and "Capturing full page" twice in
       * a row is a real case. */
      say(text) {
        el.textContent = '';
        el.textContent = text;
      },
    };
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

  /* The pill's standing guidance, in the words a person would use to explain
   * it over your shoulder. */
  const HINT_IDLE = 'Drag over anything to capture it';
  const HINT_FRAMED = 'Mark it up, or drag the edges to adjust';

  function hintFor(mode) {
    return mode === 'adjusting' ? HINT_FRAMED : HINT_IDLE;
  }

  /* How long the "done" moment stays on screen before the overlay goes, and
   * how much of that is the fade. Long enough to read the tick and see the
   * flash; short enough that nobody waits for it. */
  const DONE_MS = 650;
  const DEGRADED_DONE_MS = 1600;
  const LEAVE_MS = 200;

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
    NC.destroy = destroy;

    /* Scroll lock. The backdrop is a still image, so a scroll underneath it
     * would silently desync the overlay from the page it depicts. */
    const scroll = { x: window.scrollX, y: window.scrollY };
    /* !important, and restored with its original priority. A page that sets
     * `html { overflow: scroll !important }` would otherwise keep its
     * scrollbar, which narrows the host by the scrollbar's width and squeezes
     * the backdrop out of register with every coordinate measured against
     * innerWidth. */
    const rootStyle = document.documentElement.style;
    const prevOverflow = rootStyle.getPropertyValue('overflow');
    const prevPriority = rootStyle.getPropertyPriority('overflow');
    rootStyle.setProperty('overflow', 'hidden', 'important');
    cleanup.add(() => {
      if (prevOverflow) rootStyle.setProperty('overflow', prevOverflow, prevPriority);
      else rootStyle.removeProperty('overflow');
      window.scrollTo(scroll.x, scroll.y);
    });

    /* Focus is restored to whatever had it, so dismissing the overlay puts the
     * user back exactly where they were. */
    const previouslyFocused = document.activeElement;
    cleanup.add(() => {
      try { previouslyFocused?.focus?.({ preventScroll: true }); } catch { /* element is gone */ }
    });

    const announcer = createAnnouncer(cleanup);
    session.announcer = announcer;

    const stage = stageModule.mount({ bitmap, metrics, cssText }, cleanup);
    session.stage = stage;

    const ops = opsModule.create({ onChange: () => { annotate.paint(); rail.sync(); } });
    session.ops = ops;

    const selection = selectionModule.create({
      layer: stage.layer,
      view: stage.view,
      metrics,
      setHole: stage.setHole,
      onChange: (rect, mode) => {
        stage.root.dataset.mode = mode;
        toolbar.avoid(rect);
        toolbar.setHint(hintFor(mode));
        annotate.paint();
        rail.position(mode === 'adjusting' ? rect : null, toolbar.bottom());
        rail.sync();
        if (!rect) {
          // Frame gone: the marks belonged to it.
          annotate.setTool(null);
          ops.clear();
        }
      },
    });
    session.selection = selection;

    const annotate = annotateModule.create({
      layer: stage.layer,
      bitmap,
      metrics,
      ops,
      getRect: () => selection.rect,
      onChange: () => {
        stage.root.dataset.tool = annotate.tool ?? '';
        annotate.paint();
        rail.sync();
        toolbar.setHint(hintFor(selection.mode));
      },
    });
    session.annotate = annotate;

    const rail = railModule.create({
      layer: stage.layer,
      view: stage.view,
      annotate,
      ops,
      actions: {
        copy: () => finish('copy'),
        save: () => finish('save'),
      },
    });
    session.rail = rail;

    const toolbar = toolbarModule.create({
      layer: stage.layer,
      actions: {
        captureVisiblePage: () => selection.selectAll(),
        captureFullPage: () => captureFullPage(),
        /* Evaluated once, at mount. The page is frozen under a scrim from this
         * moment on, so its height cannot change while the pill is up. */
        canCaptureFullPage: () => fullpageModule.hasContentBelowFold(),
        savePdf: () => savePdf(),
        cancel: () => destroy(),
      },
    });
    session.toolbar = toolbar;

    /* Deferred until every piece exists: the change handlers wired above refer
     * to annotate, rail and toolbar, so nothing may fire until all three are
     * bound. */
    rail.init();

    /* With a tool active the pointer belongs to annotation, not to reframing.
     * Selection only sees the event when no tool has claimed it. */
    cleanup.listen(stage.root, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      /* Handles always resize, tool or no tool. Marks are anchored in
       * viewport coordinates, so reframing never moves them -- there was no
       * reason to make the user drop the tool just to adjust an edge. */
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
    cleanup.listen(stage.root, 'pointerup', (e) => {
      if (annotate.onPointerUp(e)) {
        try { stage.root.releasePointerCapture(e.pointerId); } catch { /* gone */ }
        return;
      }
      selection.onPointerUp(e);
    });
    cleanup.listen(stage.root, 'pointercancel', (e) => {
      if (annotate.onPointerUp(e)) return;
      selection.onPointerUp(e);
    });

    /* Capture phase, on the document: the page must not see these keys, and a
     * page that stops propagation on its own handlers must not be able to
     * swallow our Escape. */
    cleanup.listen(document, 'keydown', (event) => {
      // The text tool owns the keyboard while it is open.
      if (annotate.editing) return;
      /* Mid-capture the overlay is hidden and only Escape means anything. A
       * stray P or Ctrl+Z would otherwise change tools or history on a UI the
       * user cannot see. */
      if (session?.capturing && event.key !== 'Escape') return;

      const mod = event.ctrlKey || event.metaKey;
      const stop = () => { event.preventDefault(); event.stopPropagation(); };

      if (event.key === 'Escape') {
        stop();
        /* A capture in flight outranks the ladder below: the overlay is hidden
         * and the page is scrolled somewhere the user did not put it, so Esc
         * has exactly one sensible meaning. */
        if (session?.capturing) { session.cancelRequested = true; return; }
        /* One step back per press, never straight out: a chosen tool releases
         * first, then the frame clears, and only then does the overlay exit. */
        if (annotate.tool) annotate.setTool(null);
        else if (selection.rect) selection.clear();
        else destroy();
        return;
      }

      if (mod && event.key.toLowerCase() === 'z') {
        stop();
        event.shiftKey ? ops.redo() : ops.undo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') { stop(); ops.redo(); return; }
      if (mod && event.key.toLowerCase() === 'c') { stop(); finish('copy'); return; }
      if (mod && event.key.toLowerCase() === 's') { stop(); finish('save'); return; }
      if (mod) return;

      // Single-key tool shortcuts, but only once there is a frame to draw on.
      if (selection.rect && !event.altKey && rail.handleKey(event.key)) { stop(); return; }

      if (selection.onKeyDown(event)) { stop(); return; }

      /* The overflow lock pins the document, but not an inner scroller that
       * has focus: Space or PageDown would still slide content out from
       * under the frozen backdrop. */
      if (event.target !== stage.host && SCROLL_KEYS.has(event.key)) stop();
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
      /* A full-page capture WILL fire this, on essentially every real page.
       * The overlay pins the document with overflow:hidden, which removes the
       * scrollbar and widens the viewport; the capture lifts that lock, the
       * scrollbar comes back, and innerWidth drops by its width. That is a
       * real size change by this test's own measure, and standing down on it
       * would tear the overlay out from under its own capture every time.
       *
       * Suppressed rather than made smarter: during a capture the bitmap this
       * guard protects is about to be replaced by the stitch anyway. */
      if (session?.capturing) return;
      if (window.innerWidth === metrics.cssWidth &&
          window.innerHeight === metrics.cssHeight) return;
      destroy();
    });

    /* Compose once, then hand the same bytes to whichever action was asked
     * for. Failure leaves the overlay up so the capture is not lost. */
    async function finish(action) {
      /* One at a time. A second Ctrl+C while the first is in flight would
       * queue a second copy and a second teardown timer. */
      if (session?.finishing) return;
      const canvas = annotate.compose();
      if (!canvas) {
        toolbar.setHint('Drag over something first, then copy or save it');
        return;
      }
      session.finishing = true;
      toolbar.setHint(action === 'copy' ? 'Copying…' : 'Saving…', 'busy');

      let res;
      try {
        /* Straight from this document when it can: it is focused and holds
         * the user's activation, which the offscreen document never does. */
        if (action === 'copy' && await clipboard.writePng(canvas)) {
          res = { ok: true, via: 'page' };
        } else {
          res = await chrome.runtime.sendMessage({
            type: `nc:${action}`, dataUrl: canvas.toDataURL('image/png'),
          });
        }
      } catch (err) {
        res = { ok: false, error: String(err) };
      }
      if (!session) return;
      session.finishing = false;

      if (res?.ok) {
        if (res.degraded) {
          /* Pasted as HTML rather than a real image flavour. Say so instead of
           * letting it look like a clean copy that silently is not one.
           *
           * Through the NOTICE, not the hint: below 640px the hint is
           * display:none, and this overlay tears itself down 1.6s later. Put
           * here, the one message that tells the user their clipboard does not
           * hold a real image would have been invisible on every narrow
           * window, with no second chance to see it.
           *
           * Short text on the badge, full sentence in the hint and the title,
           * because the notice has to survive a 400px pill without pushing it
           * off screen. */
          toolbar.setNotice('Copied as HTML');
          toolbar.setHint(res.note ?? 'Copied (as HTML)', 'success');
          celebrate(DEGRADED_DONE_MS);
        } else {
          toolbar.setHint(action === 'copy' ? 'Copied. Paste it anywhere' : 'Saved', 'success');
          celebrate(DONE_MS);
        }
        return;
      }

      if (res?.cancelled) { toolbar.setHint(hintFor(selection.mode)); return; }
      toolbar.setHint(action === 'copy' ? 'Couldn’t copy that. Try again?'
                                        : 'Couldn’t save that. Try again?', 'error');
      console.error('[NhakoCapture]', action, 'failed:', res?.error);
    }
    session.finish = finish;

    /* The shutter flash over the frame, then a soft fade, then teardown. The
     * timings only decorate the delay that was already there; the image is
     * on the clipboard before any of this starts. */
    function celebrate(total) {
      stage.flash(selection.rect);
      setTimeout(() => { if (session?.stage === stage) stage.leave(); }, total - LEAVE_MS);
      setTimeout(() => { if (session?.stage === stage) destroy(); }, total);
    }

    /* Full-page capture. The loop hides the overlay and drives the document,
     * geometry decides the composition, stitch draws it, and the service
     * worker hands the result to the editor window.
     *
     * `session` is re-checked after every await: destroy() can run underneath
     * this (Esc, a resize, the tab navigating) and nulls it. */
    async function captureFullPage() {
      if (session?.capturing) return;
      session.capturing = true;
      session.cancelRequested = false;

      const startedAt = Date.now();
      /* The hint is set for sighted users; the announcer is what actually
       * reaches a screen reader, because the pill is about to be hidden and
       * this one is not. The badge that follows is browser chrome and is not
       * in the accessibility tree at all. */
      toolbar.setHint('Scrolling through the page…');
      announcer.say('Capturing the whole page. This takes a few seconds.');

      try {
        const result = await fullpageModule.run({
          hide: () => stage.hide(),
          show: () => { if (session) stage.show(); },
          shouldCancel: () => !session || session.cancelRequested === true,
          /* The badge, not the pill. The pill is hidden for the duration by
           * design, and browser chrome is the one surface that cannot end up
           * inside the screenshot. Fire-and-forget -- a dropped progress tick
           * is not worth interrupting a capture for. */
          onProgress: (index, total) => {
            chrome.runtime
              .sendMessage({ type: 'nc:progress', index, total })
              .catch(() => {});
          },
          scaleY: metrics.scaleY,
        });

        if (!session) return;

        if (result.cancelled) {
          toolbar.setHint(hintFor(selection.mode));
          announcer.say('Stopped. The page is back the way it was.');
          return;
        }
        if (!result.ok) {
          toolbar.setHint('Couldn’t capture the whole page', 'error');
          announcer.say('The whole-page capture did not work.');
          console.error('[NhakoCapture] full page failed:', result.error);
          return;
        }

        const captureMs = Date.now() - startedAt;

        toolbar.setHint('Putting it together…');
        let canvas;
        try {
          canvas = await stitchModule.stitch(result.tiles, {
            scaleY: metrics.scaleY,
            cssHeight: result.documentHeight,
          });
        } catch (err) {
          if (!session) return;
          toolbar.setHint('Couldn’t capture the whole page', 'error');
          console.error('[NhakoCapture] stitch failed:', err);
          return;
        }
        if (!session) return;

        const elapsed = Date.now() - startedAt;
        console.info(
          `[NhakoCapture] full page: ${result.tiles.length} tiles in ${captureMs}ms ` +
          `(${Math.round(captureMs / result.tiles.length)}ms/tile), ` +
          `stitched ${canvas.width}x${canvas.height} in ${elapsed - captureMs}ms, ` +
          `${result.fullDocumentHeight}px document${result.capped ? ' — CAPPED' : ''}`
        );

        /* Handed over as a data URL because extension messaging serialises to
         * JSON -- a canvas, an ImageBitmap or a page-origin blob URL all fail
         * to survive the trip, and a page-origin blob is opaque to the editor
         * window anyway. The service worker turns it into a blob URL on the
         * far side, where the editor can actually read it. */
        /* Extension messages are capped at 64MB of JSON. A tall, photo-heavy
         * page at 2x can push a PNG past that, and the handoff then fails
         * after the user has waited through the whole capture. JPEG at high
         * quality is a fraction of the size and still far sharper than any
         * downscale would have been. */
        let dataUrl = canvas.toDataURL('image/png');
        if (dataUrl.length > MAX_HANDOFF_CHARS) dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        const handoff = await chrome.runtime.sendMessage({
          type: 'nc:full-page-done',
          dataUrl,
          width: canvas.width,
          height: canvas.height,
          capped: result.capped,
        }).catch((err) => ({ ok: false, error: String(err) }));

        if (!handoff?.ok) {
          if (!session) return;
          toolbar.setHint('Couldn’t capture the whole page', 'error');
          announcer.say('The whole-page capture did not work.');
          console.error('[NhakoCapture] handoff failed:', handoff?.error);
          return;
        }

        /* The other endpoint. Said before teardown, and from an element that
         * outlives the overlay by design. */
        announcer.say(
          `Got the whole page, ${canvas.width} by ${canvas.height} pixels` +
          `${result.capped ? ', cut off at the size limit' : ''}. Opening it in a new window.`
        );

        /* The editor window owns the capture now. Leaving the overlay up would
         * put a frozen viewport in front of a page the user has finished with,
         * behind a window they are about to work in. */
        destroy();
      } finally {
        /* Cleared on every exit -- success, cancel, failure, and a teardown
         * that happened underneath us. A counter left frozen at 7/12 on the
         * toolbar is a worse lie than no counter at all. */
        chrome.runtime.sendMessage({ type: 'nc:progress', done: true }).catch(() => {});
        if (session) {
          session.capturing = false;
          /* Something asked to tear down while the loop held the scroll lock.
           * The page is back the way it was now, so it is safe to finish. */
          if (session.destroyWhenIdle) destroy();
        }
      }
    }
    /* Exposed for tools/preview.mjs, which drives the capture without the
     * pill. From DevTools, with the console context switched to the
     * extension's isolated world:
     *   NhakoCapture.modules.overlay.session.captureFullPage()
     */
    session.captureFullPage = captureFullPage;

    /* The overlay has to be gone before the PDF is rendered -- printToPDF
     * rasterises the live DOM, and our scrim and toolbars are part of it. Tear
     * down first, then ask; the message still lands, because the content
     * script's world outlives the overlay it mounted. */
    async function savePdf() {
      destroy();
      try {
        await chrome.runtime.sendMessage({ type: 'nc:pdf' });
      } catch (err) {
        console.error('[NhakoCapture] PDF request failed:', err);
      }
    }

    /* Focus trap. The page underneath is still focusable, and tabbing into it
     * from a modal overlay leaves a keyboard user driving a page they cannot
     * see, with no way back. Pull focus home whenever it escapes the host. */
    cleanup.listen(document, 'focusin', (event) => {
      if (!session) return;
      if (event.target === stage.host || stage.host.contains(event.target)) return;
      // composedPath sees through the shadow boundary; contains() does not.
      if (event.composedPath?.().includes(stage.host)) return;
      stage.root.focus({ preventScroll: true });
    }, true);

    stage.root.focus({ preventScroll: true });

    return { metrics };
  }

  /* Comfortably under Chromium's 64MB message cap, leaving room for the JSON
   * envelope and the second hop from the service worker to the offscreen
   * document. */
  const MAX_HANDOFF_CHARS = 48 * 1024 * 1024;

  /* Keys that scroll a focused element. Swallowed while the overlay is up. */
  const SCROLL_KEYS = new Set([
    ' ', 'PageUp', 'PageDown', 'Home', 'End',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  ]);

  function destroy() {
    if (!session) return;

    /* A capture in flight owns the document's scroll lock and restores it from
     * its own record, in its own finally. Tearing down now would let that
     * restore land AFTER this one and re-apply `overflow: hidden` to a page
     * with no overlay left on it -- permanently unscrollable, with nothing on
     * screen to explain why.
     *
     * So teardown is not refused, it is deferred: cancel the loop and let it
     * finish putting the page back, then tear down for real. One teardown
     * path, one owner of the lock at a time. */
    if (session.capturing) {
      session.cancelRequested = true;
      session.destroyWhenIdle = true;
      return;
    }

    session.cleanup.runAll();
    session = null;
  }

  NC.define('overlay', {
    start,
    destroy,
    metrics: () => session?.metrics,
    get session() { return session; },
  });

  /* One listener per injection. namespace.js calls `detach` on the previous
   * build before this file runs again, so repeated invocations cannot stack
   * handlers -- and a build orphaned by an extension reload is replaced
   * rather than left holding the only listener, deaf. */
  function onMessage(msg, _sender, sendResponse) {
    /* Pressing the shortcut again while the overlay is up closes it, the way
     * Opera's does. The service worker asks before capturing, because
     * capturing first would photograph this overlay. */
    if (msg?.type === 'nc:dismiss') {
      const active = session !== null;
      destroy();
      sendResponse({ ok: true, dismissed: active });
      return false;
    }
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
  }
  chrome.runtime.onMessage.addListener(onMessage);
  NC.detach = () => chrome.runtime.onMessage.removeListener?.(onMessage);
})();
