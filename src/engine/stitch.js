/* NhakoCapture — tile stitcher
 *
 * Composes the tiles a full-page capture collected into one image.
 *
 * The arithmetic is not here. geometry.planStitch decides the canvas size and
 * every draw rectangle from measurements alone, so it can be tested without a
 * browser; this file does only the two things that genuinely need a DOM --
 * decoding tiles and drawing them. That split is the same one render.js makes,
 * and for the same reason: the maths is where the silent errors live.
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  if (!NC || NC.modules.stitch) return;

  const geometry = NC.require('geometry');

  function decode(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('a captured tile failed to decode'));
      img.src = dataUrl;
    });
  }

  /* A tile's size WITHOUT decoding it.
   *
   * The plan needs every tile's dimensions before the first draw, which is
   * what used to force a decode of the whole set up front. But a PNG says how
   * big it is in its IHDR chunk, at a fixed offset, and captureVisibleTab only
   * ever hands back PNG -- so the two integers cost about thirty bytes of
   * base64 instead of a full-resolution bitmap.
   *
   * Returns null on anything unexpected, and the caller falls back to a real
   * decode rather than guessing. */
  function pngSize(dataUrl) {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;

    let bytes;
    // 24 bytes: the 8-byte signature, an 8-byte chunk header, width, height.
    try { bytes = atob(dataUrl.slice(comma + 1, comma + 33)); } catch { return null; }
    if (bytes.length < 24) return null;

    const be32 = (o) => (
      (bytes.charCodeAt(o) << 24) | (bytes.charCodeAt(o + 1) << 16) |
      (bytes.charCodeAt(o + 2) << 8) | bytes.charCodeAt(o + 3)
    ) >>> 0;

    if (be32(0) !== 0x89504e47) return null;      // not a PNG
    const width = be32(16);
    const height = be32(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  async function measure(dataUrl) {
    const size = pngSize(dataUrl);
    if (size) return size;
    const img = await decode(dataUrl);
    return { width: img.naturalWidth, height: img.naturalHeight };
  }

  /* Two passes, and never more than one decoded tile alive at a time.
   *
   * A tall page is dozens of full-resolution PNGs. Decoding them all before
   * drawing any holds every one in memory simultaneously, and at the 16384px
   * ceiling on a 2x display that is roughly twenty viewport bitmaps -- the tab
   * that dies from it is the user's. So: measure from the PNG headers, plan,
   * then decode-draw-release one tile per iteration. */
  async function stitch(tiles, { scaleY = 1, cssHeight = Infinity } = {}) {
    if (!tiles?.length) throw new Error('nothing to stitch');

    const measured = [];
    for (const tile of tiles) {
      const { width, height } = await measure(tile.dataUrl);
      measured.push({ y: tile.y, width, height });
    }

    const plan = geometry.planStitch(measured, { scaleY, cssHeight });

    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;

    const ctx = canvas.getContext('2d');
    /* The tiles are already at device resolution and are drawn 1:1, so any
     * smoothing here could only soften text that is currently exact. */
    ctx.imageSmoothingEnabled = false;

    /* `d.index` names the tile, rather than the draw's position implying it.
     * planStitch skips tiles past the ceiling, so the two are not the same
     * list -- see the note there for how a scrolljacking page turns that
     * assumption into a silently wrong picture. */
    for (const d of plan.draws) {
      const img = await decode(tiles[d.index].dataUrl);
      ctx.drawImage(img, d.srcX, d.srcY, d.srcW, d.srcH, d.dstX, d.dstY, d.dstW, d.dstH);
      // Nothing holds a reference past this point; the decode is collectable.
    }

    return canvas;
  }

  NC.define('stitch', { stitch });
})();
