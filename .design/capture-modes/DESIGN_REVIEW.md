# Design Review: Capture Modes and Copy Reliability

Feature slug: `capture-modes`
Reviewed against: `.design/capture-modes/DESIGN_BRIEF.md`
Date: 2026-08-26
Build state: T1–T16 built, all `[~]` (unit- and browser-verified, not yet Brave-verified)

## How this review was conducted

Screenshots were captured from a real Chromium driven over the DevTools
protocol — the actual modules, in the actual injection order, with real
dispatched input and real computed styles — at the three review breakpoints
plus the states that only exist in this feature. `tools/review-shots.mjs`
produces the set and is checked in, so the review can be re-run rather than
re-described.

Two findings below were **fixed during the review**; both were invisible to
code reading and to 190 passing browser checks, and only appeared in a
rendered image.

## Screenshots captured

`.design/capture-modes/screenshots/`

| File | What it shows |
| --- | --- |
| `review-overlay-idle-desktop-1280.png` | Pill, three actions plus dismiss, extent order |
| `review-overlay-idle-tablet-768.png` | Same, labels collapsed |
| `review-overlay-idle-mobile-375.png` | Same, four icons only |
| `review-overlay-framed-desktop-1280.png` | Selection, handles, rail |
| `review-overlay-framed-tablet-768.png` | Rail at tablet width |
| `review-overlay-framed-mobile-375.png` | Rail wrapped to three rows |
| `review-fullpage-disabled-focused-desktop-1280.png` | The disabled control, focused, explaining itself |
| `review-cap-notice-desktop-1280.png` | The 16384px cap notice |
| `review-degraded-copy-narrow-480.png` | Degraded-copy notice where the hint is hidden |
| `review-forced-colors-desktop-1280.png` | Windows High Contrast emulation |

## Verdict against the brief

The two principles this feature added both hold up in the built result.

**"The label is a promise."** `Capture visible page` now names the extent it
actually captures, and the capability its old name implied exists beside it.
The strongest evidence is the disabled state
(`review-fullpage-disabled-focused-desktop-1280.png`): on a page with nothing
below the fold, the control is greyed, focusable, ringed, and the pill reads
`Whole page already visible`. It teaches the distinction at the one moment the
distinction matters, which is what that Phase 2 override was for.

**"Never report a failure you can retry."** The original complaint — Copy
failing once, then working — is fixed at its cause rather than papered over,
and the fix is held by tests that were confirmed to fail against the pre-fix
files.

**Aesthetic fidelity.** Nothing in the new work breaks the functional-chrome
philosophy. The two new icons were chosen against nine candidates rendered at
real size; the cap notice is the only new colour and it earns it by outranking
the hint in the content hierarchy. No new spacing values, no new type sizes,
no new radii.

---

## Must fix

**None outstanding.** Both were found and fixed during this review:

1. ~~**Forced-colors mode destroyed the ink palette.**~~ *Fixed.*
   `overlay.css` had no `forced-colors` block at all — only `tokens.css`
   remapped colour tokens. So in Windows High Contrast the OS overrode every
   swatch background and all seven inks rendered as identical empty circles,
   with the stroke weights equally indistinguishable. The palette stopped being
   a palette for exactly the users most likely to need a high-contrast desktop.
   `forced-color-adjust: none` is now applied to `.nc-swatch` and
   `.nc-weight i` and nowhere else — the colour there is the content, not
   decoration, which is the case that escape hatch exists for. Selected-ink,
   selected-weight and focus rings are `box-shadow` everywhere else and
   `box-shadow` is not painted in forced-colors, so those now fall back to
   `outline: 2px solid Highlight`.
   *No test caught this. No amount of reading would have. It took a picture.*

2. ~~**The two most important controls lost their labels first.**~~ *Fixed.*
   Below 640px `.nc-btn__label { display: none }` applied to the rail's **Copy**
   and **Save** as well as the pill's, reducing the two actions the entire
   overlay exists to reach to a purple square and a downward arrow, while every
   tool beside them kept an icon that was always its whole identity. Priority
   exactly inverted. There are only two of them and the rail already wraps, so
   they now keep their labels at every width.
   *The existing test for this asserted the opposite intent and passed: it
   queried the first `.nc-btn__label` in the shadow root, which is the rail's,
   not the pill's. Now scoped, with a companion check for the exemption.*

## Should fix

3. **Touch targets are below 44×44 on a touch device.** Rail tools are 32×32,
   stroke weights 26×26, ink swatches 18×18. The selection handles already
   solve this properly — `--nc-handle-hit: 20px` gives an invisible target
   larger than the visible mark, annotated in the tokens as "Fitts, not
   cosmetics" — and the same trick would work here. Not raised to *must* because
   this is a desktop browser extension bound to `Ctrl+Shift+5`, and the brief's
   responsive section is about narrow *windows*, not phones. But the pattern to
   fix it already exists in this codebase, which makes it cheap.

4. **The rail occupies roughly a quarter of the viewport at 375px**
   (`review-overlay-framed-mobile-375.png`), wrapping to three rows below the
   selection. It fits, nothing is clipped, and it stays out of the frame — but
   at that width the tool is cramped rather than comfortable. Worth deciding
   whether 375px is a width this tool should claim to support at all, rather
   than supporting it thinly.

## Could improve

5. **The dimension badge can overlap page text** at small frame sizes
   (`review-overlay-framed-mobile-375.png`, `285 × 324` over the headline).
   Pre-existing, unchanged by this feature, and the badge must sit somewhere.

6. **One notice slot.** A degraded copy of a capped full-page capture replaces
   the cap notice with the copy notice. Recorded in T12 as accepted: both
   surfaces close 1.6s later, so a queue would cost more than it buys.

7. **The full-page icon's arrow is the only mark in the set that is nearly
   solid at 20px.** It reads correctly and was chosen over eight alternatives,
   but it carries slightly more ink than its neighbours. Only worth revisiting
   if the icon set grows.

## Checklist notes

- **Visual hierarchy** — pill dims to 0.25 opacity when the frame collides with
  it; the rail positions outside the selection and only overlays (dimmed) when
  there is no room either side. Both verified in the framed screenshots.
- **Consistency** — every new value comes from a token. The one new colour
  (`--nc-notice`) aliases `--nc-warning`. No one-off radii, shadows or sizes
  were introduced.
- **States** — default, hover, active, focus-visible, disabled all present on
  the new control; the disabled state is colour-only with `opacity: 1`, checked
  in the running UI rather than assumed.
- **Accessibility** — `--nc-text-disabled` clears 4.5:1 against all three
  grounds it can sit on, computed from the live stylesheet. The disabled
  control keeps its place in the tab order. Full-page start and end are
  announced from a live region that lives in the page and paints nothing.
- **Motion** — no new animation. `prefers-reduced-motion` still collapses every
  transition to 0ms.
- **Typography** — unchanged; system stack, no webfont, as the no-network
  promise requires.
- **Dark mode** — deliberately absent, per `tokens.css`. This is chrome over
  someone else's page and is pinned dark on purpose.

## What this review cannot tell you

Every finding here comes from headless Chromium. The one thing that matters
most and is not covered is **T18**: whether a full-page capture of a real site
in Brave takes the ~0.6 s per screenful the design assumes. Nine tasks rest on
that number and it is still derived from a documented rate limit rather than
observed. If it is materially worse, the brief's "bounded work may take time"
principle stops covering this, and T3's abort condition is still standing.
