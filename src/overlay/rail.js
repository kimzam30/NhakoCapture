/* NhakoCapture — tool rail
 *
 * Tools, inks, stroke weights, undo/redo and the two finishing actions.
 *
 * Positioned outside the selection so it never covers the thing being
 * annotated: below by default, flipped above when there is no room, clamped
 * horizontally so it can never sit half offscreen, and overlaid at reduced
 * opacity only when the frame is too tall for either.
 */
(() => {
  'use strict';

  const NC = globalThis.NhakoCapture;
  if (!NC || NC.modules.rail) return;

  const ICON = {
    pencil: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
    arrow: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
    blur: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8h.01M11 8h.01M15 8h.01M7 12h.01M11 12h.01M15 12h.01M7 16h.01M11 16h.01M15 16h.01"/>',
    highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    zoom: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/>',
    undo: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/>',
    redo: '<path d="M21 7v6h-6"/><path d="M21 13a9 9 0 1 1-3-7.7L21 8"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    save: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  };

  const TOOLS = [
    { id: 'pencil', label: 'Pencil', key: 'P' },
    { id: 'arrow', label: 'Arrow', key: 'A' },
    { id: 'blur', label: 'Blur', key: 'B' },
    { id: 'highlight', label: 'Highlight', key: 'H' },
    { id: 'text', label: 'Text', key: 'T' },
    { id: 'zoom', label: 'Zoom', key: 'Z' },
  ];

  const INKS = ['red', 'amber', 'green', 'blue', 'purple', 'white', 'black'];

  const svg = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;

  function iconButton(name, label, hint, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nc-tool';
    b.innerHTML = svg(name);
    b.title = hint ? `${label} (${hint})` : label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }

  function group(rail) {
    const g = document.createElement('div');
    g.className = 'nc-group';
    rail.appendChild(g);
    return g;
  }

  function create({ layer, view, annotate, ops, actions }) {
    const rail = document.createElement('div');
    rail.className = 'nc-rail';
    rail.hidden = true;
    rail.setAttribute('role', 'toolbar');
    rail.setAttribute('aria-label', 'Annotation tools');
    rail.addEventListener('pointerdown', (e) => e.stopPropagation());

    /* tools */
    const toolGroup = group(rail);
    const toolButtons = new Map();
    for (const t of TOOLS) {
      const b = iconButton(t.id, t.label, t.key, () => {
        annotate.setTool(annotate.tool === t.id ? null : t.id);
      });
      toolGroup.appendChild(b);
      toolButtons.set(t.id, b);
    }

    /* inks */
    const inkGroup = group(rail);
    const swatches = new Map();
    for (const ink of INKS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'nc-swatch';
      b.dataset.ink = ink;
      b.title = ink[0].toUpperCase() + ink.slice(1);
      b.setAttribute('aria-label', `${b.title} ink`);
      b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        annotate.setColor(getComputedStyle(b).backgroundColor);
      });
      inkGroup.appendChild(b);
      swatches.set(ink, b);
    }

    /* stroke weights */
    const sizeGroup = group(rail);
    const sizeButtons = new Map();
    for (const [name, value] of Object.entries(annotate.SIZES)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'nc-weight';
      b.dataset.weight = name;
      b.innerHTML = `<i style="width:${value + 2}px;height:${value + 2}px"></i>`;
      b.title = `${name[0].toUpperCase()}${name.slice(1)} stroke`;
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        annotate.setSize(value);
      });
      sizeGroup.appendChild(b);
      sizeButtons.set(value, b);
    }

    /* history */
    const histGroup = group(rail);
    const undoBtn = iconButton('undo', 'Undo', 'Ctrl+Z', () => ops.undo());
    const redoBtn = iconButton('redo', 'Redo', 'Ctrl+Shift+Z', () => ops.redo());
    histGroup.append(undoBtn, redoBtn);

    /* finish */
    const doneGroup = group(rail);
    doneGroup.classList.add('nc-group--done');
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'nc-btn nc-btn--primary';
    copyBtn.innerHTML = `${svg('copy')}<span class="nc-btn__label">Copy</span>`;
    copyBtn.setAttribute('aria-label', 'Copy to clipboard');
    copyBtn.title = 'Copy (Ctrl+C)';
    copyBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); actions.copy(); });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'nc-btn';
    saveBtn.innerHTML = `${svg('save')}<span class="nc-btn__label">Save</span>`;
    saveBtn.setAttribute('aria-label', 'Save image');
    saveBtn.title = 'Save (Ctrl+S)';
    saveBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); actions.save(); });

    doneGroup.append(copyBtn, saveBtn);
    layer.appendChild(rail);

    function sync() {
      for (const [id, b] of toolButtons) b.classList.toggle('is-active', annotate.tool === id);
      for (const [, b] of swatches) {
        b.classList.toggle('is-active',
          getComputedStyle(b).backgroundColor === annotate.color);
      }
      for (const [value, b] of sizeButtons) b.classList.toggle('is-active', annotate.size === value);
      undoBtn.disabled = !ops.canUndo;
      redoBtn.disabled = !ops.canRedo;
    }

    /* Keep the rail off the thing being annotated. */
    function position(rect, reservedTop = 0) {
      if (!rect) { rail.hidden = true; return; }
      rail.hidden = false;
      rail.classList.remove('is-overlaid');

      const box = rail.getBoundingClientRect();
      const GAP = 10;
      const below = rect.y + rect.h + GAP;
      const above = rect.y - GAP - box.height;

      let top;
      if (below + box.height <= view.height) top = below;
      /* `reservedTop` is the bottom of the command pill. Without it a tall
       * frame pushes the rail up into the pill and the two overlap. */
      else if (above >= reservedTop) top = above;
      else {
        // Frame is taller than the viewport allows: sit on its bottom edge,
        // dimmed until pointed at, rather than shoved offscreen.
        top = Math.max(0, view.height - box.height - GAP);
        rail.classList.add('is-overlaid');
      }

      const left = Math.min(
        Math.max(GAP, rect.x + rect.w / 2 - box.width / 2),
        Math.max(GAP, view.width - box.width - GAP)
      );
      rail.style.top = `${top}px`;
      rail.style.left = `${left}px`;
    }

    return {
      element: rail,

      /* Called once, after the caller has finished wiring, because it reaches
       * back into annotate whose change handler refers to this rail -- doing it
       * inside create() would touch the binding before it is initialised.
       *
       * It adopts the default ink from the palette: annotate's fallback is a
       * hex token, but getComputedStyle reports backgroundColor as rgb(), so
       * without this the comparison in sync() never matches and the default ink
       * renders as unselected. */
      init() {
        annotate.setColor(getComputedStyle(swatches.get('red')).backgroundColor);
        sync();
      },

      sync,
      position,
      hide() { rail.hidden = true; },
      TOOLS,
      /* Single-key tool shortcuts, Opera-style. */
      handleKey(key) {
        const t = TOOLS.find((x) => x.key.toLowerCase() === key.toLowerCase());
        if (!t) return false;
        annotate.setTool(annotate.tool === t.id ? null : t.id);
        return true;
      },
    };
  }

  NC.define('rail', { create, TOOLS, INKS });
})();
