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
    fullScreen: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
    pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  };

  function icon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
  }

  function button({ label, iconName, variant, onClick, title }) {
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
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  function create({ layer, actions }) {
    const pill = document.createElement('div');
    pill.className = 'nc-pill';
    pill.setAttribute('role', 'toolbar');
    pill.setAttribute('aria-label', 'Capture options');

    const hint = document.createElement('span');
    hint.className = 'nc-hint';
    hint.textContent = 'Drag to select an area';
    pill.appendChild(hint);

    const specs = [
      {
        label: 'Capture full screen',
        iconName: 'fullScreen',
        when: () => typeof actions.captureFullScreen === 'function',
        onClick: () => actions.captureFullScreen(),
      },
      {
        label: 'Save page as PDF',
        iconName: 'pdf',
        // Phase 5. Until the handler exists this button is simply absent.
        when: () => typeof actions.savePdf === 'function',
        onClick: () => actions.savePdf(),
      },
    ].filter((s) => s.when());

    for (const spec of specs) pill.appendChild(button(spec));

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

    layer.appendChild(pill);

    return {
      element: pill,
      setHint(text) { hint.textContent = text; },
      /* Bottom edge in viewport CSS px, so the rail can keep clear of it. */
      bottom() { return pill.getBoundingClientRect().bottom + 8; },
      hide() { pill.style.display = 'none'; },
      show() { pill.style.display = ''; },
      /* Keeps the pill out of the way when a selection is drawn underneath it. */
      avoid(rect) {
        const box = pill.getBoundingClientRect();
        const overlaps = rect && rect.y < box.bottom && rect.x < box.right && rect.x + rect.w > box.left;
        pill.style.opacity = overlaps ? '0.25' : '';
        pill.style.pointerEvents = overlaps ? 'none' : '';
      },
    };
  }

  NC.define('toolbar', { create });
})();
