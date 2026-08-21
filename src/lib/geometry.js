/* NhakoCapture — geometry
 *
 * All the maths that turns a mouse drag in CSS pixels into an exact pixel
 * rectangle inside the captured bitmap. Kept pure and dependency-free so it can
 * be unit-tested outside a browser (tools/test-geometry.mjs) -- this is the one
 * part of the extension where an off-by-DPR error silently produces a subtly
 * wrong screenshot rather than an obvious crash.
 *
 * Two coordinate spaces:
 *   CSS space    - what the mouse reports, what window.innerWidth measures.
 *   Device space - what captureVisibleTab actually returns, which is CSS space
 *                  multiplied by devicePixelRatio (and browser zoom).
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  if (!NC || NC.modules.geometry) return;

  /* captureVisibleTab's bitmap is not always exactly innerWidth * dpr -- the
   * compositor rounds, and browser zoom lands on fractional ratios. Deriving X
   * and Y independently from the real bitmap absorbs that instead of trusting
   * devicePixelRatio, which is why this takes measurements rather than reading
   * the global. */
  function measure(bitmapWidth, bitmapHeight, cssWidth, cssHeight) {
    if (!(bitmapWidth > 0 && bitmapHeight > 0)) {
      throw new RangeError('measure: bitmap has no area');
    }
    if (!(cssWidth > 0 && cssHeight > 0)) {
      throw new RangeError('measure: viewport has no area');
    }
    return {
      scaleX: bitmapWidth / cssWidth,
      scaleY: bitmapHeight / cssHeight,
      bitmapWidth,
      bitmapHeight,
      cssWidth,
      cssHeight,
      // Reported for diagnostics only. Never used for maths: on a fractional
      // zoom scaleX and scaleY can differ, and averaging them loses a pixel.
      dpr: bitmapWidth / cssWidth,
    };
  }

  /* A drag can start at any corner and end at any other. Normalise to a
   * top-left origin with non-negative extent. v1 open-coded this Math.min /
   * Math.abs dance in three separate places. */
  function normalizeDrag(x0, y0, x1, y1) {
    return {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0),
    };
  }

  function clampToViewport(rect, cssWidth, cssHeight) {
    const x = Math.max(0, Math.min(rect.x, cssWidth));
    const y = Math.max(0, Math.min(rect.y, cssHeight));
    return {
      x,
      y,
      w: Math.max(0, Math.min(rect.w, cssWidth - x)),
      h: Math.max(0, Math.min(rect.h, cssHeight - y)),
    };
  }

  /* CSS rect -> integer device rect, clamped inside the bitmap.
   *
   * Rounding the edges rather than the origin and size independently is
   * deliberate: rounding w and h on their own lets a rectangle drift by a pixel
   * depending on where it starts. Rounding both edges and subtracting keeps
   * adjacent selections seamless. */
  function toDevice(rect, m) {
    const left = Math.round(rect.x * m.scaleX);
    const top = Math.round(rect.y * m.scaleY);
    const right = Math.round((rect.x + rect.w) * m.scaleX);
    const bottom = Math.round((rect.y + rect.h) * m.scaleY);

    const x = Math.max(0, Math.min(left, m.bitmapWidth));
    const y = Math.max(0, Math.min(top, m.bitmapHeight));

    return {
      x,
      y,
      w: Math.max(0, Math.min(right, m.bitmapWidth) - x),
      h: Math.max(0, Math.min(bottom, m.bitmapHeight) - y),
    };
  }

  /* The whole viewport, in device pixels. Used by "Capture full screen". */
  function fullViewport(m) {
    return { x: 0, y: 0, w: m.bitmapWidth, h: m.bitmapHeight };
  }

  /* Below this a drag is a misclick, not a selection. v1 used the same 10px
   * threshold and it is the right call; it is just centralised now. */
  const MIN_DRAG = 10;

  function isMeaningfulDrag(rect, min = MIN_DRAG) {
    return rect.w >= min && rect.h >= min;
  }

  function hasArea(rect) {
    return rect.w > 0 && rect.h > 0;
  }

  NC.define('geometry', {
    measure,
    normalizeDrag,
    clampToViewport,
    toDevice,
    fullViewport,
    isMeaningfulDrag,
    hasArea,
    MIN_DRAG,
  });
})();
