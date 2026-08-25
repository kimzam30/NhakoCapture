/* NhakoCapture — full-page capture loop
 *
 * Drives the document past the viewport one screenful at a time and collects a
 * tile per screenful. The stitching happens elsewhere (engine); this file owns
 * the part that touches the live page, which is the part that can go wrong in
 * ways the user has to live with.
 *
 * Three rules govern everything here.
 *
 * 1. OUR OVERLAY IS NEVER ON SCREEN DURING A CAPTURE.
 *    captureVisibleTab photographs the tab as rendered, shadow DOM included.
 *    This is the same hazard background.js was rewritten around -- "on a slow
 *    frame that puts the extension's own toolbar inside the user's screenshot".
 *    The overlay is hidden ONCE for the whole loop rather than per tile, and
 *    the loop does not begin until the repaint that removed it has actually
 *    landed. Hiding per tile would multiply the number of chances to get this
 *    wrong by the number of tiles.
 *
 * 2. TILES ARE PLACED WHERE THE PAGE ACTUALLY WENT, NOT WHERE WE ASKED IT TO GO.
 *    Every tile records the scrollY read back after the scroll settled. Asking
 *    for 3 x 900 and trusting it is how fractional zoom, sub-pixel rounding and
 *    a page that clamps its own scrolling turn into hairline seams; reading it
 *    back means an inaccurate scroll costs nothing, because the tile is simply
 *    placed where it belongs.
 *
 * 3. THE PAGE IS PUT BACK. ALWAYS.
 *    Scroll position and every style this file touches are restored on success,
 *    on cancel, on capture failure, and on a throw from anywhere in between --
 *    which is why the restore lives in a finally and works from a record taken
 *    before the mutation, never from a recomputed "what it should have been".
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  if (!NC || NC.modules.fullpage) return;

  const geometry = NC.require('geometry');

  /* Chromium rate-limits captureVisibleTab to roughly two calls per second and
   * rejects the excess outright. Rather than sleep a fixed interval and hope,
   * the loop paces itself to this floor AND retries a quota rejection -- the
   * floor keeps us from tripping it, the retry means tripping it costs a delay
   * instead of a dropped tile. */
  const MIN_CAPTURE_INTERVAL = 550;
  const QUOTA_BACKOFF = 400;
  const QUOTA_RETRIES = 6;

  /* A scroll is "settled" when scrollY stops moving between frames. The
   * deadline exists for pages that never settle: a scroll-linked animation, an
   * infinite feed appending content, a scrolljacking library fighting us. */
  const SETTLE_TIMEOUT = 500;

  /* The lazy-load sweep. No captures happen during it, so the browser's
   * capture rate limit does not apply and it can move at whatever pace lets
   * IntersectionObservers actually fire. The step cap is what stops an
   * infinite feed -- which grows every time we reach its end -- from sweeping
   * forever; the brief puts such pages out of scope, but "out of scope" must
   * still mean "terminates". */
  const PREPASS_STEP_DELAY = 60;
  const PREPASS_MAX_STEPS = 200;
  const IMAGE_SETTLE_TIMEOUT = 1200;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* rAF does not fire in a hidden tab. If the user switches away mid-capture,
   * an unguarded await here would hang the loop until they came back, with the
   * overlay hidden and the page scrolled somewhere they did not leave it. */
  function nextFrame() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(finish);
      setTimeout(finish, 100);
    });
  }

  function documentHeight() {
    const d = document.documentElement;
    const b = document.body;
    return Math.max(
      d?.scrollHeight || 0, d?.offsetHeight || 0, d?.clientHeight || 0,
      b?.scrollHeight || 0, b?.offsetHeight || 0
    );
  }

  /* Below this, a "full page" capture would produce a second tile that adds
   * nothing a person would notice -- a few pixels of margin. The button says
   * so instead of producing a near-duplicate of the visible capture. */
  const FOLD_SLACK = 32;

  function hasContentBelowFold() {
    return documentHeight() > window.innerHeight + FOLD_SLACK;
  }

  async function settleScroll(target) {
    /* behavior:'instant' beats a page-level `scroll-behavior: smooth`, which
     * would otherwise animate every step and put a half-scrolled page in the
     * tile. scrollBehavior is pinned to 'auto' by the caller as well; belt and
     * braces, because the CSS can sit on either element. */
    window.scrollTo({ top: target, left: 0, behavior: 'instant' });

    const deadline = Date.now() + SETTLE_TIMEOUT;
    let previous = NaN;
    for (;;) {
      await nextFrame();
      const current = window.scrollY;
      if (current === previous) return current;
      previous = current;
      if (Date.now() > deadline) return current;
    }
  }

  /* --- what we do to the live page before photographing it ----------------
   *
   * Every mutation below is recorded as the element's ENTIRE `style.cssText`
   * before it is touched, and restored by assigning that string back. Not
   * property-by-property: removing a property cannot undo a shorthand, and
   * "set it back to what it should be" is how a page ends up subtly different
   * from how the user left it. The record is the truth; nothing is recomputed.
   */

  function snapshot(el) {
    return { el, cssText: el.style.cssText };
  }

  function restoreAll(records) {
    for (const rec of records ?? []) {
      try { rec.el.style.cssText = rec.cssText; } catch { /* element is gone */ }
    }
  }

  /* The overlay pins the document with `overflow: hidden` so the frozen
   * backdrop cannot drift. That lock also makes window.scrollTo a no-op, so a
   * full-page capture has to lift it for the duration and put it back -- the
   * overlay's own teardown then restores the page's original value on top. */
  function unlockScroll() {
    const root = document.documentElement;
    const record = snapshot(root);
    root.style.setProperty('overflow', 'visible', 'important');
    return record;
  }

  /* Pinned elements are the reason a naive stitch looks broken: a fixed header
   * is painted into every single tile, so it bands down the finished image.
   *
   * The two kinds need opposite treatment, because they differ in whether they
   * occupy space:
   *
   *   sticky  is IN flow -- it reserves its natural place and only shifts while
   *           scrolling. Setting it static returns it to that natural place, so
   *           it appears exactly once, where it belongs, and the layout does
   *           not move because the space was always reserved.
   *   fixed   is OUT of flow -- it occupies no space anywhere. It is kept for
   *           the first tile, where it genuinely belongs (it is what the top of
   *           the page looks like), and hidden for the rest. Hiding it cannot
   *           disturb the layout for the same reason it repeats: nothing is
   *           laid out around it.
   */
  function collectPinned() {
    const sticky = [];
    const fixed = [];
    /* One walk, one getComputedStyle per element. On a very large document
     * this is the most expensive thing in the whole capture, which is why it
     * happens once rather than per tile. */
    for (const el of document.querySelectorAll('*')) {
      let position;
      try { position = getComputedStyle(el).position; } catch { continue; }
      if (position === 'sticky') sticky.push(snapshot(el));
      else if (position === 'fixed') fixed.push(snapshot(el));
    }
    return { sticky, fixed };
  }

  function unstick(records) {
    for (const rec of records) {
      rec.el.style.setProperty('position', 'static', 'important');
    }
  }

  function conceal(records) {
    for (const rec of records) {
      rec.el.style.setProperty('visibility', 'hidden', 'important');
    }
  }

  /* Wake lazily-loaded content by actually visiting it. A single jump to the
   * bottom is not enough: an IntersectionObserver only fires for elements that
   * become visible, and everything jumped over never does.
   *
   * The height is re-read each step rather than planned up front, because the
   * sweep itself is what makes the document grow. */
  async function lazyLoadPrePass({ viewHeight, shouldCancel, stepDelay }) {
    let lastHeight = -1;

    for (let step = 0; step < PREPASS_MAX_STEPS; step += 1) {
      if (shouldCancel?.()) throw new Cancelled();

      const height = documentHeight();
      const limit = Math.max(0, height - viewHeight);
      await settleScroll(Math.min(window.scrollY + viewHeight, limit));
      await sleep(stepDelay);

      if (window.scrollY >= limit) {
        // At the end. If nothing grew while getting here, there is no more.
        if (height === lastHeight) break;
        lastHeight = height;
      }
    }

    /* Images that started loading during the sweep need a moment to finish, or
     * the tiles catch them half-decoded. Bounded: a single never-completing
     * image must not hold the capture hostage. */
    const deadline = Date.now() + IMAGE_SETTLE_TIMEOUT;
    for (;;) {
      const pending = [...document.images].some((img) => !img.complete);
      if (!pending || Date.now() > deadline) break;
      await sleep(60);
    }

    await settleScroll(0);
  }

  function isQuota(result) {
    return result?.quota === true ||
      /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(String(result?.error ?? ''));
  }

  class Cancelled extends Error {
    constructor() { super('full-page capture cancelled'); this.cancelled = true; }
  }

  /* One tile, paced and retried. Returns a dataUrl or throws. */
  async function captureTile(lastCaptureAt, minInterval, quotaBackoff) {
    const since = Date.now() - lastCaptureAt;
    if (since < minInterval) await sleep(minInterval - since);

    for (let attempt = 0; attempt <= QUOTA_RETRIES; attempt += 1) {
      const res = await chrome.runtime.sendMessage({ type: 'nc:capture-tile' });
      if (res?.ok && res.dataUrl) return res.dataUrl;
      if (!isQuota(res)) {
        throw new Error(res?.error || 'the browser refused to capture this tab');
      }
      await sleep(quotaBackoff * (attempt + 1));
    }
    throw new Error('the browser kept refusing to capture — rate limit');
  }

  /* `hide` and `show` are supplied by the caller because the stage owns the
   * host element; this module must not reach into it. `shouldCancel` is polled
   * rather than handed an AbortSignal so the caller can decide what counts as
   * a cancel (Esc today, a navigation tomorrow) without this file knowing. */
  /* `minInterval` and `quotaBackoff` are parameters rather than constants only
   * so the unit tests can run the loop without sitting through real pacing --
   * at the defaults a three-tile test costs 1.6 seconds of wall clock, and a
   * suite nobody wants to run is a suite that stops being run. Production
   * callers pass neither. */
  async function run({
    hide, show, onProgress, shouldCancel, scaleY = 1,
    minInterval = MIN_CAPTURE_INTERVAL,
    quotaBackoff = QUOTA_BACKOFF,
    prePass = true,
    prepassDelay = PREPASS_STEP_DELAY,
  } = {}) {
    const startX = window.scrollX;
    const startY = window.scrollY;
    const rootStyle = document.documentElement.style;
    const savedScrollBehavior = rootStyle.scrollBehavior;

    const tiles = [];
    let unlocked = null;
    let pinned = null;

    try {
      rootStyle.scrollBehavior = 'auto';
      unlocked = unlockScroll();
      hide?.();

      /* The repaint that removed the overlay has to land before the first
       * capture. Two frames, not one: the first schedules the paint, the
       * second runs after it. This is rule 1, and it is the whole reason the
       * overlay is hidden once up front instead of around each tile. */
      await nextFrame();
      await nextFrame();

      const viewH = window.innerHeight;

      if (prePass) {
        await lazyLoadPrePass({ viewHeight: viewH, shouldCancel, stepDelay: prepassDelay });
      }
      if (shouldCancel?.()) throw new Cancelled();

      /* Pinned elements are neutralised BEFORE the document is measured, and
       * the document is measured AFTER the pre-pass. Both orderings matter:
       * the sweep is what makes a lazy page grow, and un-sticking can move
       * content. Planning against a height measured before either would plan
       * against a page that no longer exists. */
      pinned = collectPinned();
      unstick(pinned.sticky);
      await nextFrame();

      const plan = geometry.planFullPage({
        docHeight: documentHeight(), viewHeight: viewH, scaleY,
      });
      const { stops, capped } = plan;

      let lastCaptureAt = 0;
      for (let i = 0; i < stops.length; i += 1) {
        if (shouldCancel?.()) throw new Cancelled();

        const landedAt = await settleScroll(stops[i]);
        if (shouldCancel?.()) throw new Cancelled();

        onProgress?.(i + 1, stops.length);
        const dataUrl = await captureTile(lastCaptureAt, minInterval, quotaBackoff);
        lastCaptureAt = Date.now();

        /* Placed where the page actually went. If two stops land on the same
         * offset -- a page that refused to scroll, or a clamped final stop on
         * an exact-multiple document -- the second tile is redundant, not new. */
        if (tiles.length && tiles[tiles.length - 1].y === landedAt) {
          tiles[tiles.length - 1].dataUrl = dataUrl;
        } else {
          tiles.push({ y: landedAt, dataUrl });
        }

        /* Fixed elements belong to the top of the page and nowhere else. They
         * are hidden only after the first tile has them, so the finished image
         * shows the header once rather than either banding it down every
         * screenful or losing it entirely. */
        if (i === 0) {
          conceal(pinned.fixed);
          await nextFrame();
        }
      }

      return {
        ok: true,
        tiles,
        capped,
        viewport: { width: window.innerWidth, height: viewH },
        documentHeight: plan.cssHeight,
        fullDocumentHeight: plan.fullCssHeight,
        pinned: { sticky: pinned.sticky.length, fixed: pinned.fixed.length },
      };
    } catch (err) {
      if (err?.cancelled) return { ok: false, cancelled: true };
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      /* Rule 3. Every one of these restores from a record taken before its
       * mutation, inside a finally, so a throw anywhere above cannot leave the
       * page scrolled to the bottom with its header invisible and our overlay
       * gone.
       *
       * THE ORDER IS LOAD-BEARING: the scroll must be put back BEFORE the
       * overflow lock goes back on. Re-locking first pins the document exactly
       * where the last tile left it and makes the restoring scroll a silent
       * no-op -- the same trap that made the loop unable to scroll in the
       * first place, just at the other end. */
      if (pinned) { restoreAll(pinned.sticky); restoreAll(pinned.fixed); }
      window.scrollTo({ top: startY, left: startX, behavior: 'instant' });
      if (unlocked) restoreAll([unlocked]);
      rootStyle.scrollBehavior = savedScrollBehavior;
      show?.();
    }
  }

  NC.define('fullpage', {
    run,
    hasContentBelowFold,
    documentHeight,
    FOLD_SLACK,
    MIN_CAPTURE_INTERVAL,
  });
})();
