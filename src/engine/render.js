/* NhakoCapture — render pipeline
 *
 * Replays the op list over the captured bitmap. This runs for the live preview
 * and for the exported image, from the same code and the same inputs, so what
 * you see in the frame is byte-for-byte what lands on the clipboard.
 *
 * Two coordinate spaces are in play. The canvas is sized in DEVICE pixels so
 * the export is full resolution, but ops are recorded in viewport CSS pixels.
 * Rather than convert every point, the context transform is set once so that
 * drawing in CSS coordinates lands in the right device pixels -- which also
 * makes line widths and font sizes scale for free.
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  if (!NC || NC.modules.render) return;

  const geometry = NC.require('geometry');

  /* Map viewport CSS coordinates onto the cropped canvas. `k` is the canvas's
   * resolution relative to the device-pixel crop: 1 for an export, less for an
   * on-screen preview that does not need every device pixel. */
  function cssSpace(ctx, rect, m, k = 1) {
    const sx = m.scaleX * k, sy = m.scaleY * k;
    ctx.setTransform(sx, 0, 0, sy, -rect.x * sx, -rect.y * sy);
  }

  function deviceSpace(ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function strokeStyle(ctx, op) {
    ctx.strokeStyle = op.color;
    ctx.lineWidth = op.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  /* Freehand. Drawing straight segments between raw pointer samples looks
   * faceted, so the path runs through the midpoints with the samples as
   * quadratic control points -- the standard smoothing, and cheap. */
  function drawPencil(ctx, op) {
    const pts = op.points;
    if (pts.length < 2) {
      // A tap still deserves a dot.
      ctx.fillStyle = op.color;
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], op.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    strokeStyle(ctx, op);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.lineTo(pts.at(-1)[0], pts.at(-1)[1]);
    ctx.stroke();
  }

  function drawArrow(ctx, op) {
    const [x0, y0] = op.from;
    const [x1, y1] = op.to;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;

    /* Head scales with stroke weight but is capped against the shaft length, so
     * a short arrow stays an arrow instead of becoming a triangle. */
    const head = Math.min(op.size * 4 + 6, len * 0.5);
    const angle = Math.atan2(dy, dx);
    const spread = 0.42;

    strokeStyle(ctx, op);
    ctx.beginPath();
    // Stop the shaft short of the tip so the head's point stays crisp.
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1 - Math.cos(angle) * head * 0.55, y1 - Math.sin(angle) * head * 0.55);
    ctx.stroke();

    ctx.fillStyle = op.color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - Math.cos(angle - spread) * head, y1 - Math.sin(angle - spread) * head);
    ctx.lineTo(x1 - Math.cos(angle + spread) * head, y1 - Math.sin(angle + spread) * head);
    ctx.closePath();
    ctx.fill();
  }

  /* Marker pen. `multiply` is what makes it read as translucent ink over the
   * page rather than a slab of colour on top of it -- text underneath stays
   * legible, which is the entire point of a highlighter. */
  function drawHighlight(ctx, op) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = op.alpha ?? 0.45;
    strokeStyle(ctx, op);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    const pts = op.points;
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();
  }

  function drawText(ctx, op) {
    if (!op.text) return;
    ctx.save();
    ctx.font = `${op.weight ?? 600} ${op.size}px ${op.font}`;
    ctx.textBaseline = 'top';
    /* A dark halo so the text survives landing on dark content. Cheaper and
     * more legible than a background plate, and it never covers the pixels the
     * annotation is pointing at. */
    /* Enough to carry the glyph over dark content, not so much that the text
     * reads as an outline drawing. */
    ctx.lineWidth = Math.max(1.5, op.size / 10);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineJoin = 'round';
    ctx.strokeText(op.text, op.at[0], op.at[1]);
    ctx.fillStyle = op.color;
    ctx.fillText(op.text, op.at[0], op.at[1]);
    ctx.restore();
  }

  /* One scratch canvas for the whole module, resized in place.
   *
   * A fresh canvas per blur, per render, is an allocation and a full-resolution
   * copy multiplied by the number of blurs on the frame -- and render() runs on
   * every pointermove of every stroke, not just at export. Sharing it is safe
   * because each blur still copies the LIVE canvas at the moment it draws, so
   * stacked blurs compound exactly as before; only the allocation is reused. */
  let scratch = null;
  let tiny = null;

  function sized(c, w, h) {
    const ctx = c.getContext('2d');
    if (c.width !== w || c.height !== h) {
      // Assigning either dimension already clears the canvas.
      c.width = w;
      c.height = h;
    } else {
      ctx.clearRect(0, 0, w, h);
    }
    return ctx;
  }

  /* Only the region a blur can reach is copied, not the whole canvas: the
   * blurred rect plus the filter's reach on every side. On a large frame the
   * full copy was most of the cost of every blur on every repaint. */
  function snapshotOf(canvas, x, y, w, h) {
    if (!scratch) scratch = document.createElement('canvas');
    sized(scratch, w, h).drawImage(canvas, x, y, w, h, 0, 0, w, h);
    return scratch;
  }

  /* Redaction, not decoration: this replaces the pixels with a blurred copy of
   * themselves, so the original values are not recoverable from the export.
   * Drawing a semi-transparent grey box over them would leave them in the file.
   *
   * Runs in canvas space and samples from a snapshot of the canvas, so stacked
   * blurs compound instead of each sampling the pristine base.
   *
   * Two layers, because a Gaussian alone leaks at the canvas edge. The filter
   * treats everything past the edge as transparent, so wherever the blurred
   * rect touches the edge of the frame its blur comes out translucent -- and
   * composited over the ORIGINAL pixels, which then show through. A region
   * blurred in the corner of a "capture visible page" kept a sharp ghost of
   * what it was meant to hide. So the rect is first overwritten with an
   * opaque, heavily downsampled copy of itself, and the Gaussian lands on that:
   * where it thins out, what shows through is already destroyed.
   */
  function drawBlur(ctx, op, { canvas, rect, m, k }) {
    const dev = geometry.toDevice(
      geometry.clampToViewport(op.rect, m.cssWidth, m.cssHeight), m);
    if (dev.w <= 0 || dev.h <= 0) return;
    // Same crop offset the base image was drawn with, then into canvas pixels.
    const base = geometry.toDevice(rect, m);
    const x0 = Math.max(0, Math.round((dev.x - base.x) * k));
    const y0 = Math.max(0, Math.round((dev.y - base.y) * k));
    const x1 = Math.min(canvas.width, Math.round((dev.x + dev.w - base.x) * k));
    const y1 = Math.min(canvas.height, Math.round((dev.y + dev.h - base.y) * k));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return;

    /* Radius scales with the region and with DPR: a fixed pixel blur that hides
     * 12px text leaves 40px headlines readable. */
    const radius = Math.max(op.radius ?? 8, Math.min(dev.w, dev.h) / 12) *
      Math.max(1, m.scaleX) * k;

    const reach = Math.ceil(radius * 2);
    const sx = Math.max(0, x0 - reach), sy = Math.max(0, y0 - reach);
    const sw = Math.min(canvas.width, x1 + reach) - sx;
    const sh = Math.min(canvas.height, y1 + reach) - sy;
    const snapshot = snapshotOf(canvas, sx, sy, sw, sh);

    if (!tiny) tiny = document.createElement('canvas');
    const cell = Math.max(2, radius);
    const tw = Math.max(1, Math.round(w / cell));
    const th = Math.max(1, Math.round(h / cell));
    sized(tiny, tw, th).drawImage(snapshot, x0 - sx, y0 - sy, w, h, 0, 0, tw, th);

    deviceSpace(ctx);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tiny, 0, 0, tw, th, x0, y0, w, h);
    ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(snapshot, 0, 0, sw, sh, sx, sy, sw, sh);
    ctx.restore();
    ctx.filter = 'none';
  }

  const PAINTERS = {
    pencil: drawPencil,
    arrow: drawArrow,
    highlight: drawHighlight,
    text: drawText,
  };

  function drawOp(ctx, op, env) {
    if (op.tool === 'blur') {
      drawBlur(ctx, op, env);
      cssSpace(ctx, env.rect, env.m, env.k);
      return;
    }
    const paint = PAINTERS[op.tool];
    if (paint) paint(ctx, op);
  }

  /* Compose the frame: base bitmap cropped to the selection, then every op
   * replayed over it. Returns the device rect that was used.
   *
   * `resolution` below 1 renders a smaller canvas of the same picture. The
   * export always runs at 1. The on-screen preview in the editor window does
   * not: there a full-page capture is fitted into the window at a fraction of
   * its size, and rendering all of its device pixels -- up to 16384 tall --
   * on every pointermove is what made drawing on one crawl. */
  function render(canvas, { bitmap, metrics, rect, ops, resolution = 1 }) {
    const dev = geometry.toDevice(rect, metrics);
    if (dev.w <= 0 || dev.h <= 0) return dev;

    const k = resolution > 0 && resolution < 1 ? resolution : 1;
    const cw = Math.max(1, Math.round(dev.w * k));
    const ch = Math.max(1, Math.round(dev.h * k));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;

    const ctx = canvas.getContext('2d');
    deviceSpace(ctx);
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(bitmap, dev.x, dev.y, dev.w, dev.h, 0, 0, cw, ch);

    const env = { canvas, rect, m: metrics, dev, k };
    cssSpace(ctx, rect, metrics, k);
    for (const op of ops) drawOp(ctx, op, env);
    deviceSpace(ctx);

    return dev;
  }

  NC.define('render', { render, drawOp });
})();
