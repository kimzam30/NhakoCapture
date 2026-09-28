/* NhakoCapture — command pill
 *
 * The bar at the top: what to do, and the two whole-page shortcuts that skip
 * framing entirely.
 *
 * Actions are declared with a `when` predicate rather than hardcoded, so a
 * capability that has not been built yet simply does not render. Shipping a
 * visible button that does nothing is worse than shipping one button fewer.
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  if (!NC || NC.modules.toolbar) return;

  /* Inline SVG with currentColor, the one reusable idea carried over from v1.
   * No icon dependency, no web-accessible asset, no network. */
  const ICON = {
    /* Corner brackets: "the frame you can see". Carried over unchanged from the
     * button this one renames -- the label was wrong, the icon never was, and
     * principle 2 says muscle memory wins where we could differ but shouldn't. */
    visiblePage: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
    /* The SAME frame's top corners, a rule across where the fold is, and an
     * arrow through it. Sharing the bracket motif is the point: below 640px the
     * labels vanish and these two sit adjacent with nothing else to tell them
     * apart, so they must read as siblings differing in one thing -- extent --
     * which is exactly what they are. The rule is the fold; the arrow is the
     * part you would otherwise never capture.
     *
     * Chosen against nine alternatives rendered side by side at 20px and 56px:
     *   - a wide rect with a centred stem (the obvious first draft) reads
     *     unmistakably as a monitor on a stand, at both sizes;
     *   - a tall page outline is indistinguishable from the PDF icon two slots
     *     along;
     *   - top brackets over a centred double chevron, with no rule, acquires a
     *     face at small sizes, and a face is not subordinate to the page it
     *     sits over.
     * The horizontal rule is what removes that last reading: it imposes an
     * axis where the pareidolia wanted symmetry. The arrow's stem is longer
     * than it looks like it needs to be, because at 20px a short one merges
     * into its own head and the whole mark turns into a blob. */
    fullPage: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M3 11h18"/><path d="M12 14v6"/><path d="m9 17 3 3 3-3"/>',
    pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  };

  /* Drawn for 18px: the logo's butterfly with its outline dropped, which on
   * dark glass would only thicken it. Pink over lavender, pale body. */
  const BUTTERFLY =
    '<svg viewBox="0 0 24 24">' +
    '<path d="M11.4 11.2C10.9 8.4 8.8 5.6 6.2 5.8 3.8 6 3.6 9.2 5.6 11 7 12.2 9.4 12.4 11.4 12.2Z" fill="#ff91e7"/>' +
    '<path d="M12.6 11.2C13.1 8.4 15.2 5.6 17.8 5.8 20.2 6 20.4 9.2 18.4 11 17 12.2 14.6 12.4 12.6 12.2Z" fill="#ff91e7"/>' +
    '<path d="M11.4 13C9.2 13 7.2 14 7.1 15.8 7 17.5 8.7 18.3 10 17.5 11.1 16.8 11.4 15.2 11.4 13Z" fill="#c3a6f0"/>' +
    '<path d="M12.6 13C14.8 13 16.8 14 16.9 15.8 17 17.5 15.3 18.3 14 17.5 12.9 16.8 12.6 15.2 12.6 13Z" fill="#c3a6f0"/>' +
    '<rect x="11.25" y="8.6" width="1.5" height="9.4" rx=".75" fill="#f7f1f9"/>' +
    '</svg>';

  function icon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
  }

  function button({ label, iconName, variant, onClick, title, enabled = true, reason, announce }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nc-btn' + (variant ? ` nc-btn--${variant}` : '');
    btn.innerHTML = iconName ? icon(iconName) : '';
    if (label) {
      const span = document.createElement('span');
      span.className = 'nc-btn__label';
      span.textContent = label;
      btn.appendChild(span);
    }
    /* The label is hidden by CSS in a narrow window, so the accessible name
     * has to come from somewhere that does not disappear with it. */
    btn.setAttribute('aria-label', label || title || '');
    if (title) btn.title = title;

    if (!enabled) {
      /* aria-disabled, NOT the disabled attribute. `disabled` would take this
       * control out of the tab order, and the whole argument for rendering a
       * disabled button rather than omitting it is that it explains itself --
       * a reason a keyboard user cannot reach is not a reason, it is a dead
       * control with an excuse. */
      btn.setAttribute('aria-disabled', 'true');
      btn.classList.add('is-disabled');
      if (reason) btn.title = reason;
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      /* A disabled control still answers -- with the reason it is disabled.
       * Clicking and getting nothing at all teaches nothing. */
      if (!enabled) { announce?.(reason); return; }
      onClick();
    });

    if (!enabled && reason) {
      btn.addEventListener('focus', () => announce?.(reason));
      btn.addEventListener('blur', () => announce?.(null));
    }
    return btn;
  }

  /* `top` overrides the stylesheet's placement, in stage-local CSS pixels. The
   * fallback window uses it to lift the pill into the margin above the capture,
   * where it does not sit on top of the image it describes. */
  function create({ layer, actions, top, origin = { x: 0, y: 0 } }) {
    const pill = document.createElement('div');
    pill.className = 'nc-pill';
    pill.setAttribute('role', 'toolbar');
    pill.setAttribute('aria-label', 'Capture options');

    /* Restored when a disabled control loses focus, so the reason does not
     * outlive the moment it was relevant to. */
    let baseHint = 'Drag over anything to capture it';

    /* Created empty and always present, not inserted on demand. A live region
     * that arrives with its text already in it is unreliably announced; one
     * that is already in the tree and then changes is not. It also sits BEFORE
     * the hint, because it outranks it -- a notice about what the capture
     * actually IS is worth more than guidance on what to do with it. */
    /* The family mark: the Nhako butterfly, small, at the head of the pill.
     * Decorative -- the toolbar is already labelled -- and dropped in a narrow
     * window, where every pixel belongs to a control. */
    const mark = document.createElement('span');
    mark.className = 'nc-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = BUTTERFLY;
    pill.appendChild(mark);

    const notice = document.createElement('span');
    notice.className = 'nc-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.hidden = true;
    pill.appendChild(notice);

    const hint = document.createElement('span');
    hint.className = 'nc-hint';
    /* Also the status channel: "Copied!", "Save failed" and the degraded-copy
     * notice all land here, and the window closes right after, so a
     * screen-reader user has to be told rather than shown. */
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    hint.textContent = baseHint;
    pill.appendChild(hint);

    /* Announces without disturbing the hint the overlay is managing: passing
     * null puts back whatever was last set through setHint. */
    const announce = (text) => { hint.textContent = text ?? baseHint; delete hint.dataset.tone; };

    /* Ordered by extent, then export, then dismiss. `when` decides whether a
     * control exists at all -- a capability this surface can never have does
     * not render, which is the original rule and is unchanged. `enabled`
     * decides whether a control that COULD work here works on this particular
     * document; that one renders, and says why not. */
    const specs = [
      {
        label: 'Visible area',
        title: 'Capture everything on screen',
        iconName: 'visiblePage',
        when: () => typeof actions.captureVisiblePage === 'function',
        onClick: () => actions.captureVisiblePage(),
      },
      {
        label: 'Whole page',
        title: 'Scroll and capture the whole page',
        iconName: 'fullPage',
        when: () => typeof actions.captureFullPage === 'function',
        enabled: () => actions.canCaptureFullPage?.() !== false,
        reason: 'The whole page already fits on screen',
        onClick: () => actions.captureFullPage(),
      },
      {
        label: 'Save as PDF',
        title: 'Save the whole page as a PDF',
        iconName: 'pdf',
        // Phase 5. Until the handler exists this button is simply absent.
        when: () => typeof actions.savePdf === 'function',
        onClick: () => actions.savePdf(),
      },
    ].filter((s) => s.when());

    for (const spec of specs) {
      pill.appendChild(button({
        ...spec,
        enabled: spec.enabled ? spec.enabled() !== false : true,
        announce,
      }));
    }

    if (specs.length) {
      const divider = document.createElement('div');
      divider.className = 'nc-divider';
      pill.appendChild(divider);
    }

    pill.appendChild(button({
      iconName: 'close',
      variant: 'icon',
      label: 'Cancel',
      title: 'Cancel (Esc)',
      onClick: () => actions.cancel(),
    }));

    /* A pointerdown that reaches the root would start drawing a frame behind
     * the pill. Stop it here rather than special-casing the pill in
     * selection.js's hit test. */
    pill.addEventListener('pointerdown', (e) => e.stopPropagation());

    if (top !== undefined) pill.style.top = `${top}px`;
    layer.appendChild(pill);

    return {
      /* `tone` colours the moment: 'success' draws a tick before the text,
       * 'error' warms it. Any plain hint afterwards clears it. */
      setHint(text, tone) {
        baseHint = text;
        hint.textContent = text;
        if (tone) hint.dataset.tone = tone;
        else delete hint.dataset.tone;
      },
      /* Separate from setHint on purpose. The hint is also the status channel
       * -- "Copying…", "Saved", the degraded-clipboard note -- so a notice put
       * there is erased by the first thing the user does, which for a
       * statement they need to have read before they paste is exactly the
       * wrong lifetime. */
      setNotice(text) {
        notice.textContent = text ?? '';
        notice.title = text ?? '';
        notice.hidden = !text;
      },
      /* Bottom edge in viewport CSS px, so the rail can keep clear of it. */
      bottom() { return pill.getBoundingClientRect().bottom + 8; },
      /* Keeps the pill out of the way when a selection is drawn underneath it.
       *
       * getBoundingClientRect is viewport-space but `rect` is stage-local, so
       * the frame has to be lifted into viewport space first. They coincide for
       * the in-page overlay, where the stage is the viewport, and do not in the
       * fallback window -- where getting this wrong dims the pill permanently. */
      avoid(rect) {
        const box = pill.getBoundingClientRect();
        const r = rect && {
          x: rect.x + origin.x, y: rect.y + origin.y, w: rect.w, h: rect.h,
        };
        const overlaps = r && r.y < box.bottom && r.x < box.right && r.x + r.w > box.left;
        /* Receded, not switched off. It used to drop to 0.25 with pointer
         * events disabled, so after "Visible area" -- which frames the whole
         * screen and therefore always overlaps -- Whole page, PDF and Cancel
         * could not be clicked at all until the frame was cleared. Now the
         * pill fades back and pointing at it brings it forward. */
        pill.classList.toggle('is-receded', Boolean(overlaps));
      },
    };
  }

  NC.define('toolbar', { create });
})();
