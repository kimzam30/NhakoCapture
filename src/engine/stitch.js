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

  /* Decoded one at a time, not with Promise.all. A tall page is dozens of
   * full-resolution PNGs; decoding them all before drawing any would hold every
   * one in memory at once, and the tab that dies from it is the user's. */
  async function stitch(tiles, { scaleY = 1, cssHeight = Infinity } = {}) {
    if (!tiles?.length) throw new Error('nothing to stitch');

    const measured = [];
    const images = [];
    for (const tile of tiles) {
      const img = await decode(tile.dataUrl);
      images.push(img);
      measured.push({ y: tile.y, width: img.naturalWidth, height: img.naturalHeight });
    }

    const plan = geometry.planStitch(measured, { scaleY, cssHeight });

    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;

    const ctx = canvas.getContext('2d');
    /* The tiles are already at device resolution and are drawn 1:1, so any
     * smoothing here could only soften text that is currently exact. */
    ctx.imageSmoothingEnabled = false;

    plan.draws.forEach((d, i) => {
      ctx.drawImage(images[i], d.srcX, d.srcY, d.srcW, d.srcH, d.dstX, d.dstY, d.dstW, d.dstH);
    });

    return canvas;
  }

  NC.define('stitch', { stitch });
})();
