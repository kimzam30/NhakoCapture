/* NhakoCapture — stage
 *
 * The shadow host, the frozen backdrop, and the scrim. Everything the user sees
 * is mounted inside a shadow root so that no page stylesheet can reach our UI
 * and none of our CSS can disturb the page underneath.
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  if (!NC || NC.modules.stage) return;

  const HOST_ID = 'nhako-capture-host';

  function adoptStyles(shadow, cssText) {
    // Constructable stylesheets avoid a <style> node the page could observe via
    // a MutationObserver on the host. Falls back where unsupported.
    if ('adoptedStyleSheets' in Document.prototype && 'replaceSync' in CSSStyleSheet.prototype) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      shadow.adoptedStyleSheets = [sheet];
      return;
    }
    const style = document.createElement('style');
    style.textContent = cssText;
    shadow.appendChild(style);
  }

  function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  /* `box` fits the stage to a rectangle instead of the whole viewport. The
   * in-page overlay omits it; the fallback editor window uses it to letterbox
   * a capture whose aspect ratio does not match the window. */
  /* `clip: false` lets the toolbars paint outside the stage box. The in-page
   * overlay clips (the stage IS the viewport, so there is no outside), but the
   * fallback window fits the capture into a letterboxed box and needs the pill
   * and rail to sit in the margin around it. */
  function mount({ bitmap, metrics, cssText, box, clip = true }, cleanup) {
    /* A previous host can survive a page's own DOM tricks; never stack two. */
    document.getElementById(HOST_ID)?.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;
    /* The host's geometry is pinned INLINE, with !important, not left to
     * :host in the shadow sheet.
     *
     * A page's own stylesheet beats a :host rule -- outer styles win that
     * cascade -- so a site with `div { width: 50% }` or `div { transform:
     * scale(.9) }` or `div { position: relative }` reached straight through
     * and shrank, moved or un-fixed the overlay, leaving the frozen backdrop
     * out of register with every coordinate measured against the viewport.
     * Only an inline !important declaration outranks all of those. It also
     * keeps the host alive on a page that says `div { display: none
     * !important }`. */
    const pin = (prop, value) => host.style.setProperty(prop, value, 'important');
    pin('display', 'block');
    pin('position', 'fixed');
    pin('z-index', '2147483647');
    pin('margin', '0');
    pin('padding', '0');
    pin('border', '0');
    pin('transform', 'none');
    pin('translate', 'none');
    pin('scale', 'none');
    pin('rotate', 'none');
    pin('filter', 'none');
    pin('clip-path', 'none');
    pin('opacity', '1');
    pin('visibility', 'visible');
    pin('min-width', '0');
    pin('min-height', '0');
    pin('max-width', 'none');
    pin('max-height', 'none');
    pin('pointer-events', 'auto');
    if (box) {
      pin('left', `${box.left}px`);
      pin('top', `${box.top}px`);
      pin('right', 'auto');
      pin('bottom', 'auto');
      pin('width', `${box.width}px`);
      pin('height', `${box.height}px`);
    } else {
      pin('inset', '0');
      pin('width', 'auto');
      pin('height', 'auto');
    }

    const shadow = host.attachShadow({ mode: 'open' });
    adoptStyles(shadow, cssText);

    const root = el('div', 'nc-root', shadow);
    if (!clip) root.classList.add('is-unclipped');
    root.setAttribute('role', 'application');
    root.setAttribute('aria-label', 'NhakoCapture — drag over anything to capture it');
    root.tabIndex = -1;

    /* Reuse the Image already decoded during handoff rather than decoding the
     * multi-megabyte data URL a second time. */
    bitmap.className = 'nc-backdrop';
    bitmap.setAttribute('alt', '');
    bitmap.setAttribute('aria-hidden', 'true');
    bitmap.draggable = false;
    root.appendChild(bitmap);

    /* Four scrim rectangles around the selection. See overlay.css for why this
     * beats a giant box-shadow spread. */
    const scrim = {
      top: el('div', 'nc-scrim', root),
      right: el('div', 'nc-scrim', root),
      bottom: el('div', 'nc-scrim', root),
      left: el('div', 'nc-scrim', root),
    };

    /* Where selection.js and toolbar.js mount. */
    const layer = el('div', 'nc-layer', root);
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';

    document.documentElement.appendChild(host);
    cleanup.add(() => host.remove());

    const view = { width: metrics.cssWidth, height: metrics.cssHeight };
    const origin = box ? { x: box.left, y: box.top } : { x: 0, y: 0 };

    /* Position the four rects so the hole is exactly `rect`. With no selection
     * the top rect covers everything and the other three collapse. */
    function setHole(rect) {
      const px = (n) => `${n}px`;
      if (!rect || rect.w <= 0 || rect.h <= 0) {
        Object.assign(scrim.top.style, {
          left: '0px', top: '0px', width: px(view.width), height: px(view.height),
        });
        for (const k of ['right', 'bottom', 'left']) {
          Object.assign(scrim[k].style, { width: '0px', height: '0px' });
        }
        return;
      }
      const { x, y, w, h } = rect;
      Object.assign(scrim.top.style, {
        left: '0px', top: '0px', width: px(view.width), height: px(y),
      });
      Object.assign(scrim.bottom.style, {
        left: '0px', top: px(y + h), width: px(view.width), height: px(Math.max(0, view.height - y - h)),
      });
      Object.assign(scrim.left.style, {
        left: '0px', top: px(y), width: px(x), height: px(h),
      });
      Object.assign(scrim.right.style, {
        left: px(x + w), top: px(y), width: px(Math.max(0, view.width - x - w)), height: px(h),
      });
    }

    setHole(null);

    /* Full-page capture takes tiles with captureVisibleTab, which photographs
     * the tab as rendered -- our shadow DOM included. The overlay therefore has
     * to leave the screen for the duration. The host's display is set
     * !important (it must survive a page whose own CSS says
     * `div { display: none !important }`), so hiding it has to outrank that
     * same declaration. */
    function setHidden(hidden) {
      host.style.setProperty('display', hidden ? 'none' : 'block', 'important');
    }

    /* The shutter flash: a white blink over the frame the moment a copy or
     * save lands. Removed when it has played, so it can never linger over a
     * capture the user keeps working on. */
    function flash(rect) {
      if (!rect || rect.w <= 0 || rect.h <= 0) return;
      const f = el('div', 'nc-flash', layer);
      Object.assign(f.style, {
        left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`,
      });
      f.addEventListener('animationend', () => f.remove(), { once: true });
      setTimeout(() => f.remove(), 800);   // animationend never fires if hidden
    }

    /* Fade the whole overlay out ahead of teardown. Purely visual: the caller
     * still owns the timer that actually destroys it. */
    function leave() {
      root.classList.add('is-leaving');
    }

    return {
      host, shadow, root, layer, view, origin, setHole, flash, leave,
      hide: () => setHidden(true),
      show: () => setHidden(false),
    };
  }

  NC.define('stage', { mount, HOST_ID });
})();
