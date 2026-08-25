# Information Architecture: Capture Modes and Copy Reliability

Feature slug: `capture-modes`
Brief: `.design/capture-modes/DESIGN_BRIEF.md`
Date: 2026-08-25

## A note on the template

This is a browser extension, not a site. There are no routes and no URLs, so the
structural questions the IA template asks in terms of pages are answered here in
terms of **surfaces** (the distinct UI contexts the tool can be in), **the
control model** (what appears in the pill and rail, and when), and **the message
contract** (the addressing scheme that does the job URLs would do — how the four
execution contexts identify and reach each other). Everything else in the
template — hierarchy, flows, naming, reuse, growth — transfers directly.

## Surface Map

Four execution contexts, three of which the user can see.

- **Service worker** `src/background.js` — invisible. Owns capture, downloads,
  the debugger/PDF route, and the action badge. The only context that can call
  `chrome.tabs.captureVisibleTab`.
  - **Offscreen document** `src/offscreen.html` — invisible. Owns the clipboard
    and blob-URL minting. Addressed by `target: 'nc-offscreen'`.
- **In-page overlay** — shadow root on the host page, mounted by
  `src/overlay/inject.js`. The primary surface. Reachable only where a content
  script can be injected.
  - **Idle / framing** — scrim, pill, no rail.
  - **Framed / annotating** — selection frame, handles, rail, pill.
  - **Capturing full page** — *the overlay is not on screen at all.* See the
    state machine; this is the structurally unusual state.
- **Editor window** `src/fallback/editor.html` — `chrome.windows.create`, popup
  type. Two distinct populations now arrive here, which is new:
  - **Restricted-page capture** — a viewport bitmap from a page that refused
    injection. Existing behaviour.
  - **Full-page capture** — a stitched image from a page that injected fine.
    New. The window is no longer only a fallback; for full page it is the
    intended destination.

## Control Model

### Command pill — in-page overlay

Left to right, and the order is deliberate: increasing extent, then export, then
dismiss.

| Slot | Control | Renders when |
| --- | --- | --- |
| 1 | Hint / status text | Always |
| 2 | `Capture visible page` | `actions.captureVisiblePage` exists |
| 3 | `Capture full page` | `actions.captureFullPage` exists — **disabled**, with reason, when the document has nothing below the fold |
| 4 | `Save page as PDF` | `actions.savePdf` exists |
| — | divider | Any of 2–4 rendered |
| 5 | Dismiss (icon) | Always |

The `when`-predicate model in `toolbar.js` is kept and **extended, not replaced**:
a spec may now also declare `enabled()` and `reason()`. `when()` still governs
existence; `enabled()` governs the disabled state. This keeps the original rule
intact — a control that can never work in this context still does not render —
while allowing a control that *could* work here and merely doesn't on this
particular document to render and explain itself.

### Command pill — editor window

Unchanged: hint plus dismiss only. Neither capture button renders, because
`when()` is false for both — there is no live tab behind this window. The
disabled state does not apply here; absence is still correct in this surface.

### Tool rail

Unchanged in both surfaces. Full-page captures inherit the identical toolset;
that is the entire argument for routing them to the editor window rather than
building a third surface.

### Action badge — browser chrome

A fourth control surface, previously used only for failure. Now dual-purpose:

| State | Badge | Colour |
| --- | --- | --- |
| Tiling, under 10 tiles | `3/9` | `--nc-badge-progress` |
| Tiling, 10 tiles or more | `83%` | `--nc-badge-progress` |
| Failure | `!` | `--nc-badge-error` |
| Otherwise | empty | — |

**Amended at build time (T6).** Chrome fits roughly four characters in a badge
before clipping, so `10/12` does not survive. The literal count this section
originally specified holds only up to nine tiles; at ten or more it becomes a
percentage, which is the only bounded form that always fits. The format is
chosen once per capture from a total known up front, so it never changes
mid-run, and the tooltip carries the exact `10 of 12` either way. The intent —
a *bounded* figure rather than an indeterminate one — survives; the literal
shape of it did not.

It is the only *visual* status channel that is structurally incapable of
appearing inside a screenshot, which is why progress lives here and not in the
pill.

**Amended at T14.** It is not the only such channel: a visually-hidden live
region in the page paints nothing and therefore cannot be photographed either,
while remaining in the accessibility tree when the overlay is hidden. It cannot
replace the badge — it has no visual presence at all — but it carries the
start-and-end announcements this document assumed the pill hint would carry.
The pill could not: the hint and the hide happen in the same task.

## Content Hierarchy

### In-page overlay, framing state
1. **The page underneath** — the subject. Everything else is scaffolding over
   somebody else's content and is subordinate to it by design.
2. **The selection frame** — the user's active decision.
3. **The rail** — acted on constantly once a frame exists; positioned adjacent
   to the frame, never over it.
4. **The pill** — read once at the start, then ignored. Top-centre, dims to 0.25
   opacity when the frame collides with it.

### Editor window, full-page capture
1. **The stitched image** — larger and more scroll-worthy than any previous
   occupant of this window.
2. **The truncation notice**, when the page exceeded the ceiling. Ranked above
   the toolset deliberately: it changes what the user believes they are holding,
   and they must read it before they paste.
3. **The rail**.
4. **The pill**.

### Action badge
Single-purpose. Failure outranks progress: a failed capture clears any counter.

## State Machine

The one genuinely new structure. States are exclusive.

```
                     ┌──────────────────────────────┐
                     │  no overlay (page as normal) │
                     └──────────────┬───────────────┘
                              Ctrl+Shift+5
                                    │  capture viewport FIRST
                                    ▼
                          ┌──────────────────┐
              ┌───────────┤  framing (idle)  │◄──────────┐
              │           └────────┬─────────┘           │
              │                    │ drag / visible page │ Esc
              │                    ▼                     │
              │           ┌──────────────────┐           │
              │           │ framed / annot.  ├───────────┘
              │           └────────┬─────────┘
              │                    │ Copy / Save
              │                    ▼
              │              (clipboard / download) ──► teardown
              │
              │ Capture full page
              ▼
   ┌─────────────────────┐   overlay HIDDEN from here on
   │ prepass (lazy-load) │   badge: 0/N
   └──────────┬──────────┘
              │ reached bottom, returned to top
              ▼
   ┌─────────────────────┐   badge: k/N          ┌──────────┐
   │       tiling        │──────────────────────►│ cancelled│
   └──────────┬──────────┘   Esc / capture fail  └────┬─────┘
              │ all tiles or ceiling hit               │ restore
              ▼                                        ▼
   ┌─────────────────────┐                     page as it was
   │      stitching      │   badge cleared
   └──────────┬──────────┘
              │ blob URL minted
              ▼
   ┌─────────────────────┐
   │    editor window    │
   └─────────────────────┘
```

**Invariants that hold across every transition out of `prepass` or `tiling`:**

1. The original `scrollX` / `scrollY` is restored. On success, on failure, on
   cancel, and on the tab being navigated out from under us.
2. Every mutated `position: fixed` / `sticky` element is restored, from a record
   taken before mutation — never by recomputing what the value "should" be.
3. The badge is cleared.
4. The overlay is either fully torn down or fully remounted. It is never left
   half-mounted, and it is never visible during a `captureVisibleTab` call.

Invariants 1 and 2 are why the loop needs a single teardown path rather than
per-branch cleanup — the same argument, and the same shape, as the
`cleanup.runAll()` discipline already in `inject.js`.

## User Flows

### Flow 1 — Capture full page (the new path)
1. User presses `Ctrl+Shift+5` on an article. Viewport is captured; overlay
   mounts in **framing**.
2. User clicks `Capture full page`.
   - If the document has no content below the fold → the button was already
     disabled; clicking it surfaces `Whole page already visible` in the hint and
     nothing else happens. Flow ends.
3. Overlay hides. Badge shows `0/N`. Page scrolls to the bottom (lazy-load
   pre-pass), then back to the top.
4. Tiling loop. Fixed/sticky neutralized. Badge counts up.
   - If user presses Esc → **cancelled**. Scroll and fixed elements restored,
     badge cleared, overlay remounts in **framing** with the original viewport
     bitmap. Nothing is lost.
   - If a `captureVisibleTab` call is refused → same as cancel, plus the failure
     badge and a reason.
   - If the ceiling is reached → stop early, carry a `truncated` flag forward.
5. Tiles stitched. Blob URL minted via the offscreen document.
6. Overlay torn down. Editor window opens with the stitched image, framed whole.
   If `truncated`, the pill states the cap.
7. User crops, annotates, copies or saves — identical to every other capture.

### Flow 2 — Capture visible page (unchanged, renamed)
1. `Ctrl+Shift+5`, overlay mounts in **framing**.
2. User clicks `Capture visible page` → `selection.selectAll()`, straight to
   **framed**. No scrolling, no badge, no window. Instant, and it stays instant.

### Flow 3 — Copy (the repaired path)
1. User presses Copy or `Ctrl+C` in either surface. Hint: `Copying…`.
2. Service worker ensures the offscreen document exists **and answers a ping**
   before sending the payload.
   - Not yet answering → retry, bounded, still inside `Copying…`. The user sees
     no failure, because there is nothing here they can act on.
   - Answers → clipboard write attempted.
3. Outcomes:
   - True image flavour → `Copied!`, teardown after 600ms.
   - HTML flavour only → the degraded note, teardown after 1600ms. This one is
     still reported, because it is a real difference in what was copied.
   - Genuinely refused → `Copy failed`, overlay stays up so the capture is not
     lost. This now means what it says.

## Naming Conventions

| Concept | Label in UI | Notes |
| --- | --- | --- |
| Viewport-extent capture | **Capture visible page** | Opera's wording. Replaces `Capture full screen`, which named neither the right extent nor the right noun — "screen" implies the monitor, including browser chrome. |
| Document-extent capture | **Capture full page** | Pairs with the above; the two labels differ in exactly one word, which is the one thing that differs. |
| Whole document as PDF | **Save page as PDF** | Unchanged. "Save" not "Capture", because it produces a file rather than an editable image. |
| One captured viewport within a full-page run | **tile** | Internal vocabulary only. Never shown. |
| The bounded upper limit on stitch height | **cap** / `capped` | User-facing phrasing: `Full page capped at 16384px — page is longer`. Never "truncated", "clipped" or "trimmed", which sound like damage rather than a stated limit. |
| Clipboard write that only produced HTML | **degraded** | Internal. User sees the plain-language note already in `offscreen.js`. |

Internal identifiers follow the labels: `captureVisiblePage`, `captureFullPage`.
The existing `captureFullScreen` and the `fullViewport` comment in
`geometry.js:91` both cite the retired label and are renamed with it — a label
that survives in the code outlives the decision that retired it.

## Component Reuse Map

| Component | Used on | Behaviour differences |
| --- | --- | --- |
| `toolbar.js` (pill) | Overlay, editor window | Overlay renders 3 actions + dismiss; editor renders dismiss only. New: `enabled()` / `reason()` on a spec. |
| `stage.js` | Overlay, editor window | Overlay fills the viewport; editor letterboxes into a box. Unchanged — but a very tall stitched image is a new stress case for `fit()`. |
| `selection.js`, `annotate.js`, `ops.js`, `render.js`, `rail.js` | Both | No differences. Full page inherits the whole toolset for free; this is the payoff of routing it here. |
| `geometry.js` | Both, plus the stitcher | Gains document-extent maths. Stays pure and browser-free so `tools/test-geometry.mjs` can cover the tile arithmetic — the highest-risk new code and the kind that fails silently rather than loudly. |
| Offscreen `make-blob-url` | Downloads, **now the editor handoff** | Same op, second consumer. Revoke bookkeeping must now handle a URL whose lifetime ends when the editor fetches it, not when a download settles. |
| Action badge | Failure reporting, **now progress** | Failure outranks progress. |

## Message Contract

The addressing scheme, which is what this project has instead of URLs. Two
namespaces, and the separation is load-bearing: `background.js` returns early on
anything carrying `target`, so the two listeners cannot both answer one message.

| Message | From → To | Status |
| --- | --- | --- |
| `nc:start` | SW → overlay | Existing |
| `nc:copy` / `nc:save` / `nc:pdf` | overlay, editor → SW | Existing |
| `nc:failed` | overlay → SW | Existing |
| `nc:capture-tile` | overlay → SW | **New.** One `captureVisibleTab`, returns a dataURL. Rate-limited by the browser; the loop paces itself. |
| `nc:full-page-done` | overlay → SW | **New.** Carries the stitched image and the `capped` flag; SW mints the blob URL and opens the editor window. |
| `nc:progress` | overlay → SW | **New.** Drives the badge. Fire-and-forget. |
| `{target:'nc-offscreen', op:'ping'}` | SW → offscreen | **New.** The readiness handshake. The whole copy fix rests on this. |
| `{target:'nc-offscreen', op:'copy-image' / 'make-blob-url' / 'revoke-blob-url'}` | SW → offscreen | Existing |

## Growth and Limits

What accumulates, and what stops it:

- **Tiles** grow with document height. Bounded by the canvas ceiling (16384
  device px), enforced *before* allocating the canvas, not after — an
  over-tall canvas fails by returning a blank or throwing, and discovering that
  after a 20-second capture is the worst possible time.
- **Ops** (annotations) grow without bound within a session and are already
  cleared when the frame is cleared. Unchanged.
- **Blob URLs** grow one per capture and are the only thing here that leaks if
  mishandled — each pins its whole PNG in memory. The existing `liveUrls` set
  and revoke-on-settle discipline extends to the new editor-handoff consumer.
- **Capture time** grows linearly with page height at roughly two tiles per
  second, plus the pre-pass. This is the one growth curve the user feels, and
  the badge counter exists to make it legible rather than to make it shorter.
