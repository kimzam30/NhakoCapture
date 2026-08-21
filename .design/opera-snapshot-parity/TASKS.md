# Build Tasks: Opera Snapshot Parity

Generated from: `.design/opera-snapshot-parity/DESIGN_BRIEF.md`
Tokens: `.design/opera-snapshot-parity/TOKENS.css`
Date: 2026-08-21

Aesthetic direction is **functional browser chrome (Swiss / utilitarian)** and is
established in the first Core UI task, T4, so the look can be judged before
anything is built on top of it.

**Status legend.** `[ ]` not started · `[~]` built, unit-tested, but its "done
when" needs a browser · `[x]` verified. Nothing reaches `[x]` until it has run
in Brave — every task here has a runtime acceptance test, so passing unit tests
is evidence, not closure.

Ordering is risk-first. T3 and T5 are the two tasks that can invalidate the
architecture — the clipboard path and the frozen-backdrop maths — so they come
before the UI that would otherwise have to be rebuilt around them.

Phase mapping is to the approved plan; the vault gate ("ready boss") applies per
phase, not per task.

## Foundation — Phase 2

- [~] **T1 · Capture-first orchestration**: rewrite `src/background.js` so the
      action handler captures `captureVisibleTab` *before* injecting anything,
      then injects the overlay files in order and hands over
      `{dataUrl, dpr, innerWidth, innerHeight}`. Done when a `console.log` in
      the content script receives a bitmap whose width equals
      `innerWidth × devicePixelRatio`. _Replaces v1's inject-then-hide-then-
      capture flow and its `setTimeout(…, 200)` race._
      **Built.** Ordering invariant is mechanically tested — `tools/test-background.mjs`
      asserts `captureVisibleTab` precedes `executeScript` precedes the handoff,
      and that a failure at either step stops the chain.

- [~] **T2 · Module namespace + injection order**: establish
      `globalThis.NhakoCapture` as the single namespace every overlay file
      attaches to, since `executeScript({files})` cannot use ES modules. Done
      when three stub files injected in sequence can call into each other.
      _New. No bundler — the zero-dependency claim in the README stays true._

- [~] **T3 · Offscreen clipboard + download path** _(risk-first)_: offscreen
      document with `reason: CLIPBOARD`; `writeImage(blob)` and
      `downloadImage(blob, filename)` using `URL.createObjectURL` and
      `chrome.downloads.download({saveAs: true})`. Done when a hardcoded test
      PNG copies **from an `http://` page** and saving opens a real destination
      picker. _Adds `offscreen` + `downloads` permissions. This is the task that
      proves the architecture: a content script's `navigator.clipboard.write`
      runs in the page's origin and is blocked on plain HTTP, and v1's
      `<a download>` is why Save has no picker._
      **Built, and the riskiest thing outstanding.** The clipboard path has two
      rungs — `navigator.clipboard.write` for a true `image/png` flavour, then a
      `copy`-event HTML fallback that pastes into chat and docs but not image
      editors. Which rung actually fires in an offscreen document is *unproven*;
      the response reports `via` so the first real run settles it.

## Core UI — Phase 3

- [ ] **T4 · Shadow host, frozen backdrop, scrim** _(sets the aesthetic)_: mount
      the shadow root (`all: initial`, `--nc-z-host`), inline `TOKENS.css` plus
      `overlay.css` into it, paint the bitmap 1:1, lay `--nc-scrim` over it, lock
      scroll. Done when invoking on a page with a CSS animation visibly freezes
      it and the page's own stylesheet demonstrably cannot alter our UI. _New.
      First use of the token file — judge the visual direction here._

- [ ] **T5 · Selection frame, handles, dimension badge** _(risk-first maths)_:
      drag to draw, 8 handles, draggable interior, arrow-key nudge (1px, 10px
      with Shift), live `W × H` badge in tabular numerals, double-stroke marquee,
      selection reads through undimmed. Done when a selection over a known
      element produces exact `selection × dpr` pixel bounds on a HiDPI display.
      _Modifies v1's border-only box, which had no handles and no reposition._

- [ ] **T6 · Command pill**: top-centre pill — hint text, `Capture full screen`,
      `Save page as PDF`, dismiss. Collapses to icons below 640px. Done when all
      three actions fire and the pill never overlaps a selection near the top.
      _Modifies v1's `btnContainer`; reuses its inline-SVG `currentColor` icon
      approach._

- [ ] **T7 · Teardown and Escape**: single `destroy()` that removes every
      listener, restores scroll and focus, and unmounts. `Escape` steps back one
      level (annotating → framing → exit). Done when invoking and dismissing ten
      times leaves no accumulated listeners and no console error. _Fixes the
      `ReferenceError` at `src/overlay/inject.js:142-147`, where the handler
      references block-scoped `overlay`/`selectionBox` from outside their block,
      and the leaked listener per injection that sits beside it._

## Interactions & States — Phase 4

- [ ] **T8 · Op list and undo/redo** _(build before any tool)_: append-only op
      records, undo/redo stacks, full re-render pipeline (base → replay ops).
      Done when ten mixed marks undo and redo in exact order. _New. Every
      subsequent tool task depends on this; immediate-mode painting cannot undo._

- [ ] **T9 · Tool rail + ink swatches**: the rail itself, positioned outside the
      selection, flipping above when there is no room below and clamping to the
      viewport. Seven-ink swatch row collapsed to the active swatch. Three stroke
      weights. Covers: idle, hover, active-tool, focus-visible, disabled.
      _Depends on: T5. Uses `--nc-accent-bright` for the active indicator —
      `--nc-accent` fails 3:1 against the chrome._

- [ ] **T10 · Pencil and arrow**: freehand path with smoothing, and a
      click-drag arrow with a proportional head. _Depends on: T8, T9._

- [ ] **T11 · Blur and highlight**: blur = `ctx.filter` over a clipped copy of
      the base region, so it redacts pixels rather than drawing grey over them;
      highlight = translucent stroke under `multiply`. Done when a blurred region
      cannot be recovered from the exported PNG. _Depends on: T8, T9._

- [ ] **T12 · Text tool**: click to place, inline editing, three sizes, current
      ink, `Escape` commits. _Depends on: T8, T9._

- [ ] **T13 · Zoom**: zoom the editing stage only — never baked into output.
      Done when exporting at 200% zoom yields identical bytes to exporting at
      100%. _Depends on: T5._

- [ ] **T14 · Copy and Save**: composite selection + ops, route through T3.
      `Copied!` for ~600ms then teardown; Save opens the picker then tears down.
      _Depends on: T3, T8._

## Full page — Phase 5

- [ ] **T15 · Save page as PDF**: `chrome.debugger` attach →
      `Page.printToPDF({printBackground: true})` → detach, with `window.print()`
      fallback when attach fails. Done when both paths produce a PDF and the
      debugger infobar reliably clears on detach. _Adds the `debugger`
      permission. Verify the fallback by opening DevTools on the tab first._

## Restricted pages — Phase 6

- [ ] **T16 · Fallback editor rebuilt on the shared engine**: `src/fallback/`
      popup gets the same `engine/` tools so `brave://` pages get an identical
      tool set. _Modifies `src/fallback/editor.html|.js`; retires the re-entrant
      `img.onload → img.src = canvas.toDataURL()` trick at `editor.js:37`._

- [ ] **T17 · Denial notice**: when even `captureVisibleTab` is refused, say so
      in a toast instead of failing silently as v1 does. Covers: injection
      blocked, capture blocked, debugger attach refused. _New._

## Responsive & Polish — Phase 7

- [ ] **T18 · Narrow-window and edge-case pass**: pill collapse below 640px, rail
      flip and clamp, selection taller than the viewport, selection flush to each
      of the four edges. Breakpoint: 640px, plus the positional rules in the
      brief.

- [ ] **T19 · Accessibility pass**: tab order through pill and rail, focus trap
      inside the shadow root, focus restored on teardown, visible focus rings,
      `aria-live` on the `W × H` badge and on `Copied!`, `prefers-reduced-motion`
      honoured, `forced-colors` sanity check. Re-measure every contrast pair in
      the brief against what actually shipped.

- [ ] **T20 · Docs correction**: rewrite `README.md` — the load path (it names
      the wrong folder), the real feature list, `Ctrl+Shift+5`, and the Escape
      claim that has never been true. Rewrite `todo.md` to drop the scroll-stitch
      strategy that decision 2 cancels.

## Review

- [ ] **T21 · Design review**: run `/design-review` against the brief.
- [ ] **T22 · Browser verification matrix**: the 11 checks in the approved plan,
      driven in Brave. _Blocked until a Chrome/Brave extension is connected._
