# Design Brief: Opera Snapshot Parity

Feature slug: `opera-snapshot-parity`
Date: 2026-08-21

## Problem

Kim moved from Opera to Brave and lost a tool that was load-bearing in his daily
work. Opera's Snapshot was one keystroke — `Ctrl+Shift+5` — and then the page
froze, he dragged a box, scribbled a red arrow on the thing he was pointing at,
hit copy, and pasted it into a chat. Never left the tab. Never thought about it.

Brave has nothing equivalent, and the extensions that claim to fill the gap
break the part that mattered: they fling you into a new tab, or they make you
save a file and re-open it somewhere else to annotate, or they want an account.
The friction is not that screenshots are impossible. It is that a two-second
reflex became a twelve-second errand, and it interrupts the thought that
prompted the screenshot in the first place.

NhakoCapture v1.0 got partway — capture, crop, copy — but it has no annotation
at all, so the "scribble a red arrow" step still means leaving for another app.

## Solution

Press `Ctrl+Shift+5` anywhere. The page freezes under a dim scrim. Drag a frame
around what matters — or take the whole viewport, or the whole document as a
PDF. A small rail of tools appears next to the frame: pencil, arrow, blur,
highlight, text. Mark it up. Press copy, and it is on the clipboard and the
overlay is gone.

The entire interaction lives on top of the page you were already looking at.
Nothing navigates. Nothing opens. The thought that prompted the screenshot
survives it.

## Experience Principles

1. **Frozen over live** — the moment you invoke the tool, the page stops being a
   webpage and becomes an image. No scrolling, no animations, no video playing
   on under your selection, no hover states firing. This resolves the tension
   between "let me interact with the page to line up my shot" and "let me get a
   stable shot" decisively in favour of stability. It is also what makes the
   capture technically honest: the pixels you frame are the pixels you get.

2. **The reflex must survive** — every decision defers to muscle memory over
   improvement. Same keystroke, same order of operations, same escape hatch, as
   Opera. Where we could design something better but different, we do not. A
   tool you have to think about has already failed at the job this one has.

3. **Nothing leaves the machine, and nothing looks like it might** — no network,
   no accounts, no cloud, and no permission prompts that would make a reasonable
   person wonder. This is why the selfie camera is cut. Trust here is not a
   feature to add, it is a thing to avoid spending.

## Aesthetic Direction

- **Philosophy**: Functional browser chrome — Swiss/utilitarian. Dense, neutral,
  legible at a glance, and visually subordinate to the content it sits over. The
  UI is scaffolding around someone else's page; the page is the subject.
- **Tone**: Quick and quiet. Confident, not chatty. No onboarding, no tooltips
  explaining the obvious, no celebratory confirmations. The one piece of feedback
  that earns its place is `Copied!`, because the window vanishes and you need to
  know it worked.
- **Reference points**: Opera Snapshot (the target), macOS Screenshot's frame and
  handles, Figma's selection marquee and dimension badge.
- **Anti-references**: Awesome Screenshot and its peers — chrome-heavy toolbars,
  sign-in walls, upsell banners, new tabs. Also anything that looks like a
  drawing app: no giant colour wheels, no brush galleries, no layers panel.

## Existing Patterns

The codebase has no framework, no build step, no `package.json`, no Tailwind, no
token file, and no fonts. The visual vocabulary is eight colour literals and one
`font-family: sans-serif`. There is nothing to extend, but there is a brand to
respect — the purple is the identity and it stays.

- **Typography**: `sans-serif` only. No webfonts, and none will be added — a
  content script cannot rely on loading an external font under an arbitrary
  page's CSP, and fetching one would break the no-network promise.
- **Colours**: `#8a2be2` (accent, 5 uses), `#9d4edd` (hover, 1), `#1e1e1e` and
  `#2d2d2d` (editor chrome), `#555555` (cancel button), and assorted
  `rgba(0,0,0,…)` scrims and shadows.
- **Spacing**: ad hoc — `10px 18px`, `8px 16px`, `15px` gaps, `20px` padding. No
  scale. One gets defined in `TOKENS.css`.
- **Components**: none reusable. `src/overlay/inject.js` has a `createBtn`
  factory and three inline lucide SVG icons; those are the only reusable ideas
  in the repo, and the icon approach (inline SVG, `currentColor`, no icon
  dependency) carries forward.

## Component Inventory

| Component | Status | Notes |
| --- | --- | --- |
| Shadow-DOM host + mount/teardown | New | `all: initial`, max z-index. The one thing standing between our UI and hostile page CSS. |
| Frozen backdrop | New | The pre-captured viewport bitmap, drawn 1:1 under everything. |
| Scrim with selection cutout | Modify | v1 dimmed everything at `rgba(0,0,0,0.6)` + blur; now the selection reads through undimmed. |
| Command pill (top) | Modify | v1's `btnContainer`. Becomes hint text + `Capture full screen` / `Save page as PDF` / dismiss. |
| Selection frame + 8 handles | Modify | v1 had a border-only box, no handles, no reposition. |
| Dimension badge | New | Live `W × H`, tabular numerals so it does not jitter while dragging. |
| Tool rail | New | Pencil, arrow, blur, highlight, text, zoom. Appears on selection commit. |
| Colour swatch row | New | Seven inks. Collapsed to the active swatch until opened. |
| Action buttons | Modify | `Copy` / `Save` exist in the fallback editor; restyled and moved into the rail. |
| Toast / denial notice | New | For restricted pages where even capture is refused. Currently v1 fails silently. |
| Fallback editor window | Modify | `src/fallback/editor.html`, rebuilt on the shared engine. |

## Key Interactions

**Launch.** `Ctrl+Shift+5` or toolbar click. The viewport is captured *before*
any of our UI exists, then the overlay mounts with that bitmap already painted.
Scroll locks. The perceived effect is the page freezing instantly; the actual
effect is that our chrome cannot contaminate the capture.

**Frame.** Crosshair cursor. Drag to draw. The badge tracks `W × H` live from the
first pixel. Below ~10×10 the drag is treated as a misclick and discarded rather
than committed — v1 already does this and it is right.

**Adjust.** On mouseup the frame commits: eight handles, draggable interior,
arrow keys nudge 1px and `Shift`+arrow 10px. The frame is adjustable
indefinitely; nothing is destructive until an action button is pressed.

**Annotate.** The tool rail appears, positioned outside the selection so it never
covers the thing being annotated — below it by default, flipping above when the
selection is near the bottom edge, and clamping to the viewport when neither
fits. Every mark is an entry in an op list, so `Ctrl+Z` / `Ctrl+Shift+Z` work
throughout and nothing is ever painted irreversibly.

**Finish.** `Copy` composites and writes to the clipboard, shows `Copied!` for
roughly 600ms, then tears down. `Save` opens a real destination picker — v1's
silent download to the default folder is a logged bug, not a feature.

**Cancel.** `Escape` at any point. From annotation it returns to frame
adjustment; from framing it exits entirely. Two presses always gets you out from
anywhere. Teardown restores scroll position and removes every listener.

## Responsive Behavior

There are no page breakpoints — the overlay is always exactly the viewport. The
adaptive behaviour is positional, and it is about the window being small or the
selection being awkwardly placed:

- Below ~640px of width the command pill drops its hint text and shows icons with
  accessible names only.
- The tool rail flips above the selection when there is no room below, and clamps
  horizontally so it is never partly offscreen.
- A selection taller than the viewport minus both bars gets the rail overlaid on
  its own bottom edge at reduced opacity, lifting to full on hover.
- Handles keep a constant screen size regardless of `devicePixelRatio`; they are
  chrome, not content, and must stay hittable on HiDPI.

## Accessibility Requirements

Contrast, measured rather than assumed — every ratio below is computed, and one
of them changed the palette:

- Body text `#f2f2f2` on `#1e1e1e` — **14.89:1** (AAA).
- Muted text `rgba(255,255,255,.62)` on `#1e1e1e` — **7.18:1** (AAA).
- White on accent `#8a2be2` — **5.96:1** (AA).
- White on accent-hover `#9d4edd` — **4.60:1** (AA).
- Faint text `rgba(255,255,255,.38)` — **3.57:1**. Fails AA for text, so it is
  restricted to disabled states and decorative dividers only, never live copy.
- **`#8a2be2` against `#1e1e1e` is 2.80:1 and fails** the 3:1 floor for non-text
  UI (WCAG 1.4.11). It therefore may not be used for the selection border, focus
  ring, or active-tool indicator on dark chrome. `--nc-accent-bright` `#a862ea`
  (4.45:1 / 3.67:1) exists for exactly those jobs.
- The selection marquee sits over arbitrary page content where no single colour
  can guarantee contrast, so it is drawn as a **double stroke** — white outer,
  accent-bright inner — the standard marquee technique.

Keyboard: the whole flow is operable without a mouse — `Tab` through the pill and
rail in visual order, `Enter`/`Space` to activate, arrows to move and resize the
frame, `Escape` to back out one level. Focus is trapped inside the shadow root
while the overlay is up and restored to the previously focused element on
teardown. Focus rings are always visible, never suppressed on mouse users.

Screen readers: the honest scope. The chrome — buttons, tool states, the live
`W × H` — is properly labelled and announced via an `aria-live="polite"` region.
Freehand annotation on a canvas is irreducibly visual and is not made
non-visually operable; pretending otherwise would be theatre. The commitment is
that a keyboard or screen-reader user can capture, frame, copy and save.

Motion: every transition respects `prefers-reduced-motion: reduce` by collapsing
to `0ms`. Nothing in this UI depends on animation to be understood.

## Out of Scope

- **Emoji and sticker picker** — cut. Needs an asset set and picker UI for little
  return in a bug-report tool.
- **Selfie camera** — cut deliberately. Requires webcam permission, which
  contradicts principle 3.
- **Scroll-stitched full-page PNG** — cut. Opera does not do this; its full-page
  output is a PDF. `todo.md` still describes the stitch pipeline and is corrected
  in Phase 7.
- Video or GIF capture. Scrolling-region capture. OCR or text extraction.
- Cloud upload, share links, accounts, history of past captures.
- Multi-monitor or off-screen-window capture — `captureVisibleTab` is scoped to
  the visible tab and that is the whole surface area.
- Internationalisation. Single-locale English.
- Capturing content inside cross-origin iframes beyond what the compositor
  already renders into the visible tab.
