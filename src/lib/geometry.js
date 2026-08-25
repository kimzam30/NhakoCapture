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

  /* The whole viewport, in device pixels. Used by "Capture visible page". */
  function fullViewport(m) {
    return { x: 0, y: 0, w: m.bitmapWidth, h: m.bitmapHeight };
  }

  /* --- full-page tiling ---------------------------------------------------
   *
   * Everything below is pure arithmetic over numbers the caller measured, for
   * the same reason the rest of this file is: an off-by-DPR or off-by-a-tile
   * error here does not crash, it produces a screenshot with a seam or a strip
   * of blank at the bottom, and nobody notices until it is already pasted into
   * a conversation.
   */

  /* Chromium will not allocate a canvas past this in either dimension. It fails
   * by handing back a blank canvas rather than throwing, so this is checked
   * before anything is allocated -- discovering it afterwards means discarding
   * a capture the user already waited twenty seconds for. */
  const CEILING_DEVICE_PX = 16384;

  /* The scroll offsets to visit, in CSS pixels.
   *
   * Deliberately not `ceil(docHeight / viewHeight)` stops at even multiples:
   *
   *  - The last stop cannot be a full step past the one before it, because the
   *    page will not scroll past its own end. It is clamped, which makes the
   *    final tile OVERLAP its predecessor. That is wanted: tiles are placed at
   *    the offset they were actually taken at, so an overlap overwrites
   *    identical pixels instead of duplicating content.
   *  - A page no taller than the viewport yields exactly one stop.           */
  function planStops(docHeight, viewHeight, maxDocHeight = Infinity) {
    if (!(viewHeight > 0)) throw new RangeError('planStops: viewport has no height');
    const height = Math.min(docHeight, maxDocHeight);
    const limit = Math.max(0, height - viewHeight);
    const stops = [];
    for (let y = 0; y < limit; y += viewHeight) stops.push(y);
    stops.push(limit);
    return stops;
  }

  /* How tall a document we are allowed to keep, in CSS pixels, given this
   * page's scale. The ceiling is a DEVICE-pixel limit, so a 2x display caps at
   * half the CSS height a 1x display would. */
  function heightCeiling(scaleY, ceiling = CEILING_DEVICE_PX) {
    return Math.floor(ceiling / (scaleY > 0 ? scaleY : 1));
  }

  function planFullPage({ docHeight, viewHeight, scaleY = 1, ceiling = CEILING_DEVICE_PX }) {
    const maxDocHeight = heightCeiling(scaleY, ceiling);
    return {
      stops: planStops(docHeight, viewHeight, maxDocHeight),
      capped: docHeight > maxDocHeight,
      cssHeight: Math.min(docHeight, maxDocHeight),
      fullCssHeight: docHeight,
      maxDocHeight,
    };
  }

  /* Turn observed tiles into draw instructions.
   *
   * `tiles` are {y, width, height} in the order captured -- y in CSS pixels as
   * READ BACK after the scroll, width/height the tile bitmap's device size.
   *
   * The canvas height is the smaller of what the document claims and what the
   * tiles actually cover, and that is not belt-and-braces, it is two distinct
   * real cases:
   *
   *   - A page shorter than the viewport produces a viewport-sized tile whose
   *     lower part is not document at all, just whatever the browser paints
   *     under a short body. Trusting the tiles would stitch that in.
   *   - A page that refuses to scroll (scrolljacking, a modal lock) produces
   *     one tile for a document that claims to be tall. Trusting the document
   *     would leave a strip of blank canvas below the only real tile.
   *
   * Taking the minimum is the only answer that is right in both.                */
  function planStitch(tiles, { scaleY = 1, cssHeight = Infinity, ceiling = CEILING_DEVICE_PX } = {}) {
    if (!tiles?.length) throw new RangeError('planStitch: no tiles');

    const width = Math.max(...tiles.map((t) => t.width));
    const placed = tiles.map((t) => ({ ...t, top: Math.round(t.y * scaleY) }));
    const coverage = Math.max(...placed.map((t) => t.top + t.height));
    const claimed = Number.isFinite(cssHeight) ? Math.round(cssHeight * scaleY) : Infinity;
    const height = Math.min(Math.min(claimed, coverage), ceiling);

    const draws = [];
    for (const t of placed) {
      if (t.top >= height) continue;              // entirely past the ceiling
      const srcHeight = Math.min(t.height, height - t.top);
      if (srcHeight <= 0) continue;
      draws.push({
        srcX: 0, srcY: 0, srcW: Math.min(t.width, width), srcH: srcHeight,
        dstX: 0, dstY: t.top, dstW: Math.min(t.width, width), dstH: srcHeight,
      });
    }

    return { width, height, draws };
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
    planStops,
    heightCeiling,
    planFullPage,
    planStitch,
    CEILING_DEVICE_PX,
  });
})();
