# Design Brief: Capture Modes and Copy Reliability

Feature slug: `capture-modes`
Date: 2026-08-25
Extends: `.design/opera-snapshot-parity/DESIGN_BRIEF.md`

## Problem

Two things are wrong with the tool as shipped, and they are wrong in different
ways.

The first is a lie. The button says **Capture full screen**, and it does not
capture the full screen — it captures the viewport, the part of the page you can
currently see. Anything below the fold is not in the image. Nobody discovers this
at the moment they press the button; they discover it later, in the chat window,
after they have already sent a screenshot that is missing the thing they were
trying to show. The label sets an expectation the code was never going to meet.

The second is a flinch. You frame a region, annotate it, press Copy, and the pill
says **Copy failed**. Press Copy again and it works. Nothing changed between the
two presses. But the first failure has already done its damage: the tool has told
you, in the one moment where you needed to trust it, that it did not do the thing
you asked. A screenshot tool that cries wolf on its primary action is a screenshot
tool you check up on, and checking up on it costs more than the two seconds the
whole interaction was supposed to take.

Underneath the mislabelled button is a real gap. There is no way to capture a
whole page as an image at all. The PDF route exists and handles arbitrary length,
but a PDF is not what you paste into a chat.

## Solution

The pill offers two captures that differ only in extent, and says so: **Capture
visible page** takes what is on screen, **Capture full page** takes the whole
document. Full page scrolls the document under a frozen scrim, capturing as it
goes, and hands the stitched result to the editor window where it can be cropped
and annotated like any other capture. While it works, the pill counts the tiles,
so a five-second operation reads as bounded work rather than a hang.

And Copy stops failing. The offscreen worker that owns the clipboard is
handshaked before it is spoken to, so the first press of Copy behaves exactly
like the second one always did.

## Experience Principles

The three principles from `opera-snapshot-parity` still govern. These are the two
that this feature specifically has to resolve, both of which put pressure on
*the reflex must survive*:

1. **The label is a promise** — a control names what it actually does, at the
   extent it actually does it. Where a capability is missing, the honest move is
   to build it or to name the limit, never to pick a word that papers over it.
   This is the principle the current `Capture full screen` violates, and it is
   why the fix is a rename *and* a new capture path rather than either alone.

2. **Bounded work may take time; instant work may not take any** — the reflex
   survives because *visible* capture stays instantaneous. Full page is a
   deliberate second gear, and it earns its seconds by showing its progress and
   staying cancellable. What is never acceptable is the reverse: an operation
   that presents as instant and then stalls, or reports failure it can recover
   from on its own.

3. **Never report a failure you can retry** — a transient internal race is not
   news the user can act on. Retry it, silently, and only surface a failure that
   is actually terminal. The degraded-clipboard notice stays, because that one is
   real information: an HTML-flavoured paste genuinely behaves differently.

## Aesthetic Direction

- **Philosophy**: Unchanged — functional browser chrome, Swiss/utilitarian, dense
  and visually subordinate to the page it sits over.
- **Tone**: Unchanged. Quick and quiet. The tile counter is the one new piece of
  chatter permitted, and only because silence during a multi-second freeze reads
  as a crash.
- **Reference points**: Opera Snapshot's toolbar, whose `Capture visible page` /
  `Capture full page` pairing is adopted verbatim.
- **Anti-references**: Extensions that show a modal progress dialog, a spinner
  overlay, or a "Processing your screenshot…" splash for what is fundamentally a
  loop with a known trip count.

## Existing Patterns

- **Typography**: `--nc-font` stack in `src/overlay/tokens.css`; pill hint and
  button labels share one size. No new type styles.
- **Colors**: existing token set. The disabled control state needs one token that
  may not exist yet — checked at token phase, not invented here.
- **Spacing**: existing scale in `tokens.css`.
- **Components**: `toolbar.js` (the pill, with its `when`-predicate action specs),
  `rail.js`, `stage.js`, `selection.js`, `annotate.js`, `ops.js`, `render.js`.
  The fallback editor at `src/fallback/editor.js` already mounts the same engine
  in a window and letterboxes a capture into it — full-page reuses it wholesale
  rather than growing a third editor surface.
- **Conventions**: no bundler, no dependencies; modules attach to
  `globalThis.NhakoCapture` via `NC.define`. Geometry stays pure and unit-tested
  outside a browser (`tools/test-geometry.mjs`).

## Component Inventory

| Component | Status | Notes |
| --- | --- | --- |
| Command pill (`toolbar.js`) | Modify | Relabel to `Capture visible page`; add `Capture full page`; support a disabled state carrying a reason. Now three actions plus dismiss — re-check the narrow-window collapse. |
| Pill hint | Modify | Carries the disabled-button reason and the truncation notice. **Not** the full-page progress — see the action badge row. |
| Action badge | Modify | Becomes the progress channel: `3/9` during tiling. Superseded the pill counter at IA phase: the overlay must be off-screen while tiles are captured, so the pill cannot exist to show one. |
| Full-page capture driver | New | Content-script side: freeze, neutralize fixed/sticky, lazy-load pre-pass, scroll-and-capture loop, restore. |
| Tile stitcher | New | Canvas composition of tiles at their observed scroll offsets. Pure, unit-testable. |
| Scroll/stitch geometry | Modify | `src/lib/geometry.js` gains document-extent maths alongside `fullViewport`. Rename the `fullViewport` comment, which currently cites the old label. |
| Offscreen handshake | Modify | `ensureOffscreen()` in `background.js` gains a readiness ping and a bounded retry. |
| Copy-event fallback | Modify | `writeViaCopyEvent` in `offscreen.js` currently calls `execCommand('copy')` with nothing selected, which returns `false`. Needs a real selection to be a functioning safety net. |
| Fallback editor window | Modify | Accepts a stitched full-page image, not just a viewport bitmap. Sizing and letterboxing already handle an arbitrary aspect ratio; verify against a very tall one. |

## Key Interactions

**Capture visible page.** Unchanged from today's `Capture full screen`: selects
the whole viewport immediately, rail appears, annotate, copy or save.

**Capture full page.** Press. The overlay hides — it must, or it lands inside
the tiles — and the extension's action badge begins counting `1/N` (a
percentage instead, past nine tiles, where the literal count no longer fits in
a badge). The document scrolls to the bottom once to wake
lazy-loaded content, returns to the top, then steps down a viewport at a time,
capturing each tile and updating the counter. Fixed and sticky elements are
neutralized for the duration so they appear once rather than banding down every
tile; they are restored afterwards, as is the original scroll position — on
success, on failure, and on cancel alike. Esc at any point aborts and restores.
When the loop finishes, the overlay tears down and the editor window opens with
the stitched image.

**A page taller than the ceiling.** Capture proceeds to Chromium's canvas limit
and stops there. The editor opens with what was captured, and the pill in that
window states the truncation: `Full page capped at 16384px — page is longer`.
No silent truncation, and no downscale: a soft, unreadable screenshot of
everything is worth less than a sharp screenshot of the first sixteen thousand
pixels.

**Copy, first press.** Identical to every subsequent press. Behind the hint, the
service worker confirms the offscreen document is listening before sending, and
retries a not-yet-listening result rather than surfacing it. `Copy failed` now
means the clipboard genuinely refused.

**Full page where it cannot work.** On restricted pages there is no content
script to drive the scroll, so the button renders **disabled with a stated
reason** rather than being omitted. This is a deliberate amendment to the rule in
`toolbar.js` ("a visible button that does nothing is worse than shipping one
button fewer"), taken so the capability stays discoverable. The amendment is
conditional: the disabled control must carry its reason accessibly —
`aria-disabled`, a title, and the reason surfaced in the hint on focus or click —
so it teaches rather than merely sits there.

## Responsive Behavior

The pill now carries three labelled actions plus dismiss. The existing collapse
(labels hidden below 640px, `aria-label` carrying the accessible name) already
covers this, but three actions push the breakpoint: verify the collapsed pill
still fits at 320px, and that the icons for visible-page and full-page are
distinguishable from one another without their labels, which is a new
requirement — they were never adjacent before.

The tile counter moved to the action badge at IA phase, so the pill-jitter
concern raised here no longer applies — the badge is fixed-width browser chrome.
It is recorded rather than deleted because the reasoning still governs anything
else that might later animate text inside the pill.

## Accessibility Requirements

- Full-page progress lives in the action badge, which is browser chrome and
  therefore **not** announced by a screen reader.
  **Amended at T14, and the gap is smaller than this brief assumed.** The
  mitigation recorded here — "the hint announces the start before the overlay
  hides" — did not work and could not have: `run()` executes synchronously up
  to its first `await`, so the hint was populated and the host was hidden in
  the *same task*, and a live region removed from the accessibility tree before
  anything observes it has not announced anything. The end-of-capture
  announcement had the identical flaw, said one statement before `destroy()`.
  Both endpoints now fire from a dedicated live region that lives in the page
  rather than in the overlay, and paints nothing — clipped to nothing at 1×1,
  so `captureVisibleTab` has nothing to photograph. That is exactly the channel
  the Out of Scope note below said would justify revisiting this, so it has
  been. It outlives teardown by four seconds, because its most important
  message is the one said at teardown.
  Per-tile progress is still not announced: a polite region firing twelve times
  is worse for a screen-reader user than a bounded start and end. The middle
  stays deliberately quiet — but the ends are now real.
- The pill hint keeps `role="status"` / `aria-live="polite"` for the disabled
  reason and the truncation notice. Polite, not assertive.
- The disabled full-page button uses `aria-disabled="true"` and stays focusable,
  so a keyboard user can reach it and hear why it is unavailable. A plain
  `disabled` attribute would remove it from the tab order and make the reason
  unreachable, which would defeat the point of showing it at all.
- Esc cancels the capture; the existing focus trap and teardown apply unchanged.
- The two capture icons need a non-colour, non-label distinction — shape alone
  must carry it in the collapsed pill.
- Contrast for the disabled state at 4.5:1 against the pill ground, or the reason
  is unreadable to the people most likely to need it.

## Out of Scope

- **Scroll-stitching inside the in-page overlay.** Full page always goes to the
  editor window. No second annotation surface.
- **Horizontal stitching.** Pages wider than the viewport are captured at
  viewport width. Horizontal scroll-stitching is not built.
- **Capturing inside scrollable sub-elements.** Only the document scroller is
  driven. A page whose content lives in an inner `overflow: scroll` div captures
  as it appears.
- **Downscaling long pages to fit the canvas ceiling.** Explicitly rejected in
  favour of capping.
- **Overlap-and-trim tile capture.** Rejected; tiles are placed at observed
  scroll offsets instead.
- **Fixing the clipboard's HTML-flavour degradation.** The rung-2 fallback is
  made to actually work; making it produce a true image flavour is not possible
  and is not attempted.
- **Per-tile progress announcements during tiling.** The channel that was
  missing when this was written now exists (see Accessibility above): a
  visually-hidden live region in the page, announced and un-photographable.
  What remains out of scope is using it for *every tile* — a polite region
  firing once per tile is chatter, not information. Start and end are
  announced; the middle is intentionally silent.
- **Infinite-scroll feeds.** A page that grows as you scroll it is captured to
  whatever extent existed when the loop started. Not detected, not special-cased.
