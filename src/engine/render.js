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

  /* Map viewport CSS coordinates onto the cropped device-pixel canvas. */
  function cssSpace(ctx, rect, m) {
    ctx.setTransform(m.scaleX, 0, 0, m.scaleY, -rect.x * m.scaleX, -rect.y * m.scaleY);
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
    ctx.lineWidth = Math.max(2, op.size / 6);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineJoin = 'round';
    ctx.strokeText(op.text, op.at[0], op.at[1]);
    ctx.fillStyle = op.color;
    ctx.fillText(op.text, op.at[0], op.at[1]);
    ctx.restore();
  }

  /* Redaction, not decoration: this replaces the pixels with a blurred copy of
   * themselves, so the original values are not recoverable from the export.
   * Drawing a semi-transparent grey box over them would leave them in the file.
   *
   * Runs in device space and samples from a snapshot of the canvas, so stacked
   * blurs compound instead of each sampling the pristine base.
   */
  function drawBlur(ctx, op, { canvas, rect, m }) {
    const dev = geometry.toDevice(
      geometry.clampToViewport(op.rect, m.cssWidth, m.cssHeight), m);
    // Same crop offset the base image was drawn with.
    const base = geometry.toDevice(rect, m);
    const x = dev.x - base.x, y = dev.y - base.y;
    if (dev.w <= 0 || dev.h <= 0) return;

    const snapshot = document.createElement('canvas');
    snapshot.width = canvas.width;
    snapshot.height = canvas.height;
    snapshot.getContext('2d').drawImage(canvas, 0, 0);

    deviceSpace(ctx);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, dev.w, dev.h);
    ctx.clip();
    /* Radius scales with the region and with DPR: a fixed pixel blur that hides
     * 12px text leaves 40px headlines readable. */
    const radius = Math.max(op.radius ?? 8, Math.min(dev.w, dev.h) / 12) * Math.max(1, m.scaleX);
    ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(snapshot, 0, 0);
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
      cssSpace(ctx, env.rect, env.m);
      return;
    }
    const paint = PAINTERS[op.tool];
    if (paint) paint(ctx, op);
  }

  /* Compose the frame: base bitmap cropped to the selection, then every op
   * replayed over it. Returns the device rect that was used. */
  function render(canvas, { bitmap, metrics, rect, ops }) {
    const dev = geometry.toDevice(rect, metrics);
    if (dev.w <= 0 || dev.h <= 0) return dev;

    if (canvas.width !== dev.w) canvas.width = dev.w;
    if (canvas.height !== dev.h) canvas.height = dev.h;

    const ctx = canvas.getContext('2d');
    deviceSpace(ctx);
    ctx.clearRect(0, 0, dev.w, dev.h);
    ctx.drawImage(bitmap, dev.x, dev.y, dev.w, dev.h, 0, 0, dev.w, dev.h);

    const env = { canvas, rect, m: metrics, dev };
    cssSpace(ctx, rect, metrics);
    for (const op of ops) drawOp(ctx, op, env);
    deviceSpace(ctx);

    return dev;
  }

  NC.define('render', { render, drawOp });
})();
