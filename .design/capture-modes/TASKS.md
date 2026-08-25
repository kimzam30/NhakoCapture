# Build Tasks: Capture Modes and Copy Reliability

Generated from: `.design/capture-modes/DESIGN_BRIEF.md`
IA: `.design/capture-modes/INFORMATION_ARCHITECTURE.md`
Tokens: `src/overlay/tokens.css` (extended) · `.design/capture-modes/DESIGN_TOKENS.md`
Date: 2026-08-25

Aesthetic direction is inherited from `opera-snapshot-parity` — functional
browser chrome, Swiss/utilitarian — and is already established in the shipped
UI. No task re-establishes it; T8 is the first task that adds a visible control
and is where the direction gets re-judged.

**Status legend** (carried over from `opera-snapshot-parity`, same discipline).
`[ ]` not started · `[~]` built and unit-tested, but its "done when" needs a
browser · `[x]` verified in Brave. Passing unit tests is evidence, not closure.

**Ordering.** T1 is first because it is the live pain and because hardening
`askOffscreen` is a prerequisite for the T7 handoff. T3 is the spike: if the
capture rate limit makes tiling unusable, the whole full-page half of this brief
is wrong and it is better to know before ten tasks are built on it.

---

## Foundation

- [~] **T1 · Offscreen readiness handshake** _(fixes the reported bug)_: add an
      `op: 'ping'` to `src/offscreen.js` and make `ensureOffscreen()` in
      `background.js` wait for a reply before `askOffscreen` sends a payload —
      with a bounded retry (a few attempts, short backoff) on
      "Receiving end does not exist", which is the transient the first Copy
      currently trips over. Retry silently; surface only a terminal failure.
      _Modifies: `background.js`, `offscreen.js`. No UI change._
      **Done when**: with the service worker freshly restarted, the very first
      press of Copy lands the image on the clipboard and never shows
      `Copy failed`. Repeat ten times from a cold worker.
      **Test**: extend `tools/test-background.mjs` — stub the offscreen doc so
      the first `sendMessage` rejects with the connection error and the second
      resolves; assert `copyImage` still returns `{ok: true}` and that the retry
      is bounded rather than infinite.
      **Built.** `ensureOffscreen` now pings until the document answers before
      any payload is sent; `askOffscreen` retries once more on a disconnect,
      which is safe because an undelivered message had no effect. A lost
      `createDocument` race is treated as success; any other creation error
      still throws. 6 new checks in `tools/test-background.mjs` (96 total), and
      they were confirmed to fail against the pre-fix file — the original throws
      the disconnect at `askOffscreen`, exactly as diagnosed.

- [~] **T2 · Repair the copy-event fallback**: `writeViaCopyEvent` calls
      `document.execCommand('copy')` with nothing selected, which returns
      `false` — so rung 2 has never been able to catch a rung-1 failure. Give it
      a real selection (a `contenteditable` holder containing the image, selected
      via a `Range`) before the call, and tear it down afterwards.
      _Modifies: `offscreen.js`. Depends on: nothing, but only observable once
      T1 stops masking it._
      **Done when**: forcing `navigator.clipboard.write` to throw still produces
      a paste into a rich-text target, and the degraded note is shown.
      **Built.** An off-screen `contenteditable` holder carries the image and is
      selected via a `Range` before `execCommand`; the prior selection is saved
      and restored, and the holder is removed in a `finally`. Rung 2 now also
      refuses to claim success when `execCommand` returns true but the copy
      event never fired — the same class of lie as T1's false failure, in the
      other direction. New file `tools/test-offscreen.mjs`, 33 checks, wired
      into `tools/test.sh`; `src/offscreen.js` previously had none. The stub
      models Chrome's real `execCommand` (empty selection → `false`, no event),
      and the suite was confirmed to fail against the pre-fix file.

- [~] **T3 · Tile capture loop** _(risk-first spike)_: message `nc:capture-tile`
      from overlay to service worker; scroll the document a viewport at a time
      and collect tiles. Overlay host hidden for the whole loop. Placement comes
      from `window.scrollY` read back **after** each scroll settles, not from
      the offset requested — that is what absorbs fractional-zoom rounding
      instead of accumulating it into a seam.
      _New: `src/overlay/fullpage.js`. Modifies: `background.js` (message),
      `manifest.json` (injection list is in `background.js`'s `OVERLAY_FILES`)._
      **Done when**: a 5-viewport article yields 5 tiles, none containing any
      part of our overlay, and the browser's capture rate limit is respected
      without dropped tiles. **If the rate limit makes this take more than ~1
      second per viewport, stop and re-open the Phase 2 decision** — the brief's
      "bounded work may take time" principle has a limit, and the fallback is to
      route full page to the PDF path instead.
      **Built.** `src/overlay/fullpage.js`, plus `hide()`/`show()` on the stage,
      an `nc:capture-tile` route that returns `{quota: true}` rather than
      throwing (so the loop can tell "wait" from "stop"), and Esc wired to
      cancel ahead of the existing Escape ladder. 39 checks in
      `tools/test-fullpage.mjs`.
      **Spike verdict: provisionally clear, NOT measured.** Chromium's
      `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` is 2, so the floor is ~500ms
      per tile; `MIN_CAPTURE_INTERVAL` is 550ms and scroll settle adds ~2
      frames, giving ~0.6s per viewport — under the 1s abort threshold, but
      **derived from a documented constant rather than observed in Brave**. The
      handler logs `ms/tile`; T18 confirms it against a real page. If the
      observed figure exceeds 1s, this task's abort condition still stands and
      the Phase 2 decision goes back on the table.
      **Deferred to T4**: `planStops` and `CEILING_DEVICE_PX` live in
      `fullpage.js` for now and move into `geometry.js` with the rest of the
      tile maths.

- [~] **T4 · Stitch geometry and canvas composition**: document-extent maths in
      `src/lib/geometry.js` (tile count, per-tile source rect, the short final
      tile, the 16384px ceiling) plus the canvas composition that consumes it.
      Pure and browser-free, per the existing convention.
      _Modifies: `geometry.js`. New: stitcher in `src/engine/`. Depends on: T3
      for the real tile shape._
      **Done when**: `tools/test-geometry.mjs` covers a page that is an exact
      multiple of the viewport, one that is not, one shorter than the viewport,
      and one past the ceiling — and the ceiling case reports `capped` rather
      than silently short output. Ceiling is checked **before** the canvas is
      allocated.
      **Built.** `planStops`, `heightCeiling`, `planFullPage` and `planStitch`
      in `geometry.js`; `src/engine/stitch.js` does only decode-and-draw, the
      same maths/DOM split `render.js` makes. `fullpage.js` now delegates
      rather than carrying its own copies. Geometry suite 26 → 70 checks.
      **The canvas height is `min(what the document claims, what the tiles
      actually cover)`** — not belt-and-braces but two real cases: a page
      shorter than the viewport yields a tile whose lower half is not document
      at all, and a page that refuses to scroll yields one tile for a document
      claiming to be tall. Trusting either source alone is wrong in one of
      them.
      **Tiles are decoded one at a time, not with `Promise.all`** — a tall page
      is dozens of full-resolution PNGs, and holding them all decoded at once
      kills the user's tab.
      Ceiling is decided by `planFullPage` from measurements before any canvas
      exists, per the done-when.

## Core UI

- [~] **T5 · Fixed/sticky neutralization and lazy-load pre-pass**: before tiling,
      scroll to the bottom once to wake lazy content, return to the top, then
      neutralize every `position: fixed` / `sticky` element for the duration.
      Restore from a record taken **before** mutation — never by recomputing what
      the value should have been.
      _Modifies: `fullpage.js`. Depends on: T3._
      **Done when**: a page with a sticky header and lazy images stitches with
      the header appearing exactly once, no blank image placeholders, and every
      mutated element back to its original inline style afterwards — verified by
      snapshotting `style.cssText` before and after.
      **Built.** Sticky and fixed get opposite treatment because they differ in
      whether they occupy space: `sticky` is in flow, so setting it `static`
      returns it to its natural place with no layout shift; `fixed` is out of
      flow, so it is kept for tile 0 (where it genuinely belongs — it is what
      the top of the page looks like) and concealed after. Pre-pass steps a
      viewport at a time rather than jumping, because an IntersectionObserver
      only fires for elements that actually become visible. Measurement now
      happens AFTER the pre-pass and AFTER un-sticking, since both change the
      document. `fullpage.js` tests rewritten around a faithful stub: 54 checks.
      **Found and fixed two real bugs T3's tests could not see**, both the same
      shape — a scroll silently doing nothing because the document was pinned:
      (a) the overlay's `overflow: hidden` was never lifted, so the loop would
      have taken every tile at scrollY 0 in a real browser; (b) the `finally`
      re-locked before scrolling back, making the restoring scroll a no-op. The
      old stub let `scrollTo` move a locked document, so it modelled the bug
      away. The new stub refuses, which is what caught (b) immediately.

- [~] **T6 · Badge as progress channel**: `nc:progress` drives
      `chrome.action.setBadgeText` with `k/N` during tiling, cleared on every
      exit. Set badge **text** colour explicitly in both states, fixing the
      existing 3.41:1 white-on-red failure badge.
      _Modifies: `background.js`. Uses: `--nc-badge-*` tokens._
      **Done when**: the counter advances during a real capture, clears on
      success, cancel and failure alike, and failure red still wins if both
      would apply.
      **Built.** `BADGE` constants in `background.js` mirroring the tokens,
      `showProgress`/`clearProgress`/`paintBadge`, an `nc:progress` route, and
      both badge states now setting their text colour explicitly — which is the
      3.41:1 white-on-red fix. Failure outranks progress through a
      `failingTabs` set: progress cannot paint over a failure, clearing
      progress cannot wipe one, a failure on one tab does not silence another,
      and relaunching clears the suppression (without which the next capture
      would show nothing). 26 new checks, 122 total in that suite.
      **Amended the IA at build time**: Chrome clips a badge at ~4 characters,
      so `10/12` does not fit. Under ten tiles shows `3/9`; ten or more shows a
      percentage. Format is fixed per capture from a total known up front, and
      the tooltip always carries the exact figure. Brief and IA updated.
      **Accessibility endpoint wired**: `Capturing full page…` is announced
      through the pill's live region *before* the overlay hides, since the
      badge itself is browser chrome and is not in the accessibility tree.

- [~] **T7 · Blob-URL handoff to the editor window**: `nc:full-page-done` carries
      the stitched image; the service worker mints a blob URL through the
      existing offscreen `make-blob-url` op and opens the editor window, which
      fetches and then revokes it. Replaces the `storage.local` dataURL path for
      full-page captures, which would exceed the 10MB quota.
      _Modifies: `background.js`, `fallback/editor.js`. Depends on: T1 (hardened
      `askOffscreen`), T4._
      **Done when**: a 12000px stitched capture opens in the editor with no
      quota error, and the blob URL is revoked after the fetch — confirmed by
      the URL being dead on a second fetch. The restricted-page path still uses
      `storage.local` and still works.
      **Built.** `openFullPageEditor` mints through the existing offscreen
      `make-blob-url`; only the URL — a short string — travels through storage.
      The editor accepts either population (`capturedImage` data URL or
      `captureBlobUrl`), since an `<img>` does not care which kind of URL it
      was handed, and revokes **after** decode via `nc:capture-consumed`
      rather than on a timer, because a window can take arbitrarily long to
      open on a busy machine. 18 new checks, 140 total in that suite.
      **The leak path is tested explicitly**: if `windows.create` fails, the
      minted URL would pin the whole stitched PNG for the life of the offscreen
      document with nothing left to consume it. It is revoked on that path, and
      a test asserts it — this is the failure mode that costs memory silently
      rather than visibly.
      **Skips the decode**: the worker sizes the editor window from the width
      and height the overlay already measured, instead of decoding a 16000px
      image for two integers it was handed. `revokeBlobUrl` extracted, since
      three call sites now need it.
      **Known limit, accepted**: a capture whose editor window is opened but
      never loaded keeps its blob URL until the offscreen document is torn
      down, which bounds the leak without eliminating it. No alarm permission
      exists to do better and adding one would cost more than it buys.

- [~] **T8 · Pill: rename, new action, disabled model** _(first visible change)_:
      `Capture full screen` → `Capture visible page`; add `Capture full page`;
      extend the action spec in `toolbar.js` with `enabled()` and `reason()`
      alongside the existing `when()`. `when()` still governs existence — the
      original rule is intact — `enabled()` governs the disabled state.
      Disabled styling uses `--nc-text-disabled`, colour only. **Not `opacity`**,
      which would drag it back under the contrast floor along with the icon.
      _Modifies: `toolbar.js`, `overlay.css`, `inject.js` (rename
      `captureFullScreen` → `captureVisiblePage`), `geometry.js:91` comment._
      **Done when**: three actions plus dismiss render in extent order; on a page
      with nothing below the fold `Capture full page` is disabled, still
      focusable, `aria-disabled="true"`, and surfaces
      `Whole page already visible` in the hint on focus or click.
      **Built and verified in a real browser.** `preview.mjs` now drives both
      states: the short fixture proves the disabled path (`aria-disabled`, no
      `disabled` attribute, still focusable, reason announced on focus and
      cleared on blur, `opacity: 1` with colour `rgb(154,154,154)` — the
      computed `--nc-text-disabled`), and a new tall fixture proves the enabled
      path. Preview suite 80 → 94 checks.
      `enabled()`/`reason()` sit alongside `when()` exactly as the IA
      specified; `when()` is untouched, so the original rule still governs
      existence. Fold check is `documentHeight() > innerHeight + 32` — under
      that slack a second tile would add nothing a person would notice.
      **Two test-quality problems found and fixed**: (a) the rail's Copy/Save
      buttons share the `.nc-btn` class, so unscoped pill queries were reaching
      *"Copy to clipboard"* — which lives in a hidden rail and cannot take
      focus, quietly making the focus assertions meaningless. All pill queries
      are now scoped to `.nc-pill`. (b) `mountOverlay` screenshotted the page
      while a previous overlay was still up, baking the old pill into the new
      backdrop and ghosting every shot after the triple-mount test. It now
      tears down first — the same discipline `background.js` gets for free by
      capturing before injecting.

- [~] **T9 · Two capture icons that survive label collapse**: the pill hides
      labels below 640px, and these two controls sit adjacent for the first time.
      Shape alone must distinguish viewport-extent from document-extent. Inline
      SVG on `currentColor`, matching the existing set.
      _Modifies: `toolbar.js` `ICON`. Depends on: T8._
      **Done when**: at 400px wide, with labels hidden, the two icons are
      told apart at a glance by someone who has not read this document.
      **Built.** Final mark: the visible-page frame's top brackets, a rule
      across the fold, and an arrow through it. The shared bracket motif makes
      the two read as siblings differing in one thing — extent — which is what
      they are.
      **Judged by rendering, not by reasoning.** Nine candidates were drawn
      side by side at 20px (in a real pill, on the real surface colour, in both
      live and disabled ink) and at 56–64px. Three separate failures had to be
      designed out, none of which were visible from the path data:
        · a wide rect with a centred stem — the obvious first draft, and what
          T8 shipped — reads unmistakably as **a monitor on a stand**;
        · a tall page outline is indistinguishable from the PDF icon two slots
          along;
        · top brackets over a centred double chevron **acquires a face** at
          small sizes, and a face is the opposite of "visually subordinate to
          the page it sits over". The horizontal rule is what removes that: it
          imposes an axis where the pareidolia wanted symmetry.
      A fourth was found only in the final in-situ zoom: a short arrow stem
      merges into its own head at 20px and the mark becomes a blob, so the stem
      is longer than it looks like it needs to be.
      **Machine-checkable parts** added to `preview.mjs` at 400px: labels
      really are hidden, both extents still offered, the two icons are not the
      same shape, neither matches the PDF icon, they still share the bracket
      motif, every control keeps an accessible name once its label is gone, and
      the pill does not overflow. Preview suite 94 → 101. The "at a glance"
      judgement itself is human and was made against the renders above.

## Interactions & States

- [~] **T10 · Cancel and the restore invariants**: Esc during pre-pass or tiling
      aborts. All four IA invariants hold on **every** exit — success, cancel,
      capture refusal, and the tab navigating out from under the loop: scroll
      restored, fixed/sticky restored, badge cleared, overlay never left
      half-mounted and never visible during a capture. Single teardown path, the
      same shape as the existing `cleanup.runAll()`.
      _Modifies: `fullpage.js`, `inject.js`. Depends on: T3, T5, T6._
      **Done when**: Esc mid-capture returns the page to its exact prior scroll
      position with the overlay remounted and the original viewport bitmap
      intact — nothing lost — and the same holds when a capture call is refused
      mid-loop.
      **Built.** Scroll, pinned-element and badge restoration were already in
      place from T3/T5/T6. This task found the two exits nothing handled, both
      only reachable when something tears down *during* a capture:
      **(a) The resize guard.** The overlay pins the document with
      `overflow: hidden`, which removes the scrollbar and widens the viewport.
      The capture lifts that lock, the scrollbar returns, `innerWidth` drops —
      a real size change by the existing guard's own measure, so it tore the
      overlay out from under its own capture. On essentially every scrollbarred
      page. Now suppressed while capturing; the bitmap that guard protects is
      about to be replaced by the stitch anyway.
      **(b) Deferred teardown.** `destroy()` mid-capture let the overlay's
      cleanup restore `overflow` first and the loop's `finally` restore its own
      recorded value *after* — re-applying `overflow: hidden` to a page with no
      overlay left on it. `destroy()` now cancels and defers, and the loop
      completes the teardown once the page is back. One owner of the lock at a
      time.
      **(c) Tab lifecycle** (`background.js`): a tab that navigates or closes
      takes its content script with it, so nothing would ever send the `done`
      that clears its counter — leaving a badge frozen at 4/9 on a tab
      capturing nothing. `tabs.onUpdated`/`onRemoved` clear it. Neither needs
      the `tabs` permission; only sensitive fields are withheld without it.
      **Both fixes verified by removal**, one at a time, against the browser
      harness — and that exercise exposed a hole in the test itself: the first
      version waited for the host to vanish, which without the deferral happens
      *instantly*, so the assertions ran before the damage landed and passed
      against the broken build. It now waits for the capture promise to settle.
      A scroll-based probe was also dropped: this browser scrolls a
      documentElement with `overflow: hidden` regardless, so that check passed
      identically in both builds — reassurance that proved nothing.
      Preview suite 101 → 109; background 140 → 145.

- [~] **T11 · Cap notice in the editor**: when tiling stopped at the ceiling, the
      editor window's pill states `Full page capped at 16384px — page is longer`
      in `--nc-notice`. Ranked above the toolset: it changes what the user
      believes they are holding.
      _Modifies: `fallback/editor.js`, `toolbar.js`. Depends on: T4, T7._
      **Done when**: a 30000px page opens capped, with the notice visible before
      any annotation is made, and an uncapped capture shows no notice.
      **Built.** A separate persistent `.nc-notice` element in the pill, not a
      hint. The hint is also the status channel — "Copying…", "Saved", the
      degraded-clipboard note — so a notice put there is erased by the first
      thing the user does, which for a statement they must have read *before*
      they paste is exactly the wrong lifetime. There is a check that it
      survives a status message that would erase a hint.
      Created empty and always present rather than inserted on demand: a live
      region that arrives with its text already in it is unreliably announced,
      one already in the tree that then changes is not. Set on a rAF, after
      `selectAll` has had its turn at the hint. Sits before the hint in DOM
      order, per the content hierarchy.
      **Quotes the height the image actually has**, not the 16384 constant it
      was clamped against — the last tile can stop short, and a round number
      the image does not match would be a smaller lie of the same kind this
      notice exists to prevent.
      Both halves covered in the browser: capped shows it, uncapped shows
      nothing. Preview 109 → 117.
      **Three test bugs found and fixed along the way**, all of the same
      family — a check that runs but measures nothing: an `imageHeight` probe
      using a document-level `querySelector` for an element inside a shadow
      root (always `undefined`, so the height assertion passed vacuously); a
      shim built by string-replacing an interpolated JSON blob, which silently
      failed to match and left the test running against the uncapped fixture;
      and two injected shims sharing one global lexical scope, where the second
      copy's `const realFetch` throws a redeclaration error before it can take
      effect. The first is now read from the shadow root and required to be a
      real number, the second is a shim factory, and the third swaps the shim
      instead of layering it.

- [~] **T12 · Copy status honesty pass**: with T1 and T2 in, confirm the three
      outcomes are distinguishable and correct — clean copy, degraded HTML copy,
      terminal failure — in both the overlay and the editor window.
      `Copy failed` must now mean the clipboard genuinely refused.
      _Modifies: nothing new; verification slice over `inject.js` and
      `editor.js`. Depends on: T1, T2._
      **Flagged as the soft task on this list at Phase 5. It was not.**
      The verification found a real honesty bug: `.nc-hint` is `display: none`
      below 640px, and the degraded-copy message lived only in the hint — so on
      any window narrower than 640px the one message telling the user their
      clipboard holds HTML rather than an image was **invisible**, and the
      overlay tore itself down 1.6s later, giving no second chance. Precisely
      inverted priority: the outcome that most needs explaining was the one
      that vanished first.
      Fixed by routing the degraded result through T11's `.nc-notice`, which
      survives the collapse. Short text on the notice so a 400px pill still
      fits, full sentence in the hint and the `title`.
      Both surfaces now report all three outcomes the same way, and both are
      checked in the browser — clean (`Copied!`, no notice), degraded (never
      claims a clean copy, raises the notice), refused (says failed, leaves the
      capture on screen to retry from). Preview 117 → 129.
      **Known interaction, not fixed**: a degraded copy of a capped full-page
      capture replaces the cap notice with the copy notice, since there is one
      notice slot. The surface closes 1.6s later either way, so a notice queue
      would cost more than it buys — recorded rather than built.

## Responsive & Polish

- [~] **T13 · Narrow-window pass**: three labelled actions plus dismiss is one
      more than the pill has ever carried. Verify collapse at 640px and that the
      collapsed pill still fits at 320px without wrapping or clipping the
      dismiss control.
      Breakpoints: 320, 400, 640, 1280. _Depends on: T8, T9._
      **Built.** A sweep over all four widths, each checked twice — bare, and
      carrying the widest thing the pill can hold. A fit test on an empty pill
      is the one that misses the failure, so the notice is present for half of
      every breakpoint's checks. Per width: fits the window, nothing clipped
      inside it, has not wrapped to a second row, dismiss reachable, labels
      collapse below 640 and show above.
      **The interesting finding was a passing test.** 320px-with-a-notice
      passed immediately, which it should not have — a 46ch notice cannot fit
      in 320px. Measuring rather than trusting showed why: the notice shrinks
      and ellipsises to 149px of its 266px natural width instead of pushing the
      pill off screen. Graceful, but it left *what survives* the truncation to
      luck. There is now an assertion that the rendered width still exceeds the
      measured width of "Full page capped" at every breakpoint — the claim has
      to survive, not just the element. `Full page capp…` is a notice;
      `Full…` is decoration.
      **The rail is checked too**, though the task text only named the pill: it
      carries six tools, seven inks, three weights, undo/redo and two actions,
      so if anything overflows a narrow window it is that, and it is the
      surface the user actually works in. It wraps (`flex-wrap: wrap`) and fits
      at every width. Preview 129 → 173.

- [~] **T14 · Accessibility pass**: `aria-disabled` with the control still in tab
      order (a plain `disabled` attribute would remove it and make the reason
      unreachable — which would defeat the entire point of rendering it);
      reason announced through the existing `role="status"` hint; focus ring
      visible on the disabled control; `--nc-text-disabled` verified at 4.5:1
      against all three grounds in the running UI; `forced-colors` check.
      **Explicitly acknowledged gap**: badge progress is browser chrome and is
      not announced. The hint announces the start before the overlay hides and
      the editor announces arrival; the middle is silent. Confirm both endpoints
      actually fire. _Depends on: T8, T10._
      **Built — and the confirmation failed, which was the point of asking.**
      *Neither* endpoint fired. `run()` is synchronous up to its first `await`,
      so `setHint('Capturing full page…')` and `stage.hide()` ran in the same
      task: the live region was populated and removed from the accessibility
      tree before anything could observe it. The arrival message had the same
      shape — said one statement before `destroy()` tore its element out. Two
      announcements that existed in the code and never reached a user.
      Fixed with a live region that lives in the **page**, not the overlay, and
      paints nothing (clipped to nothing at 1×1, `contain: strict`), so
      `captureVisibleTab` cannot photograph it. This is precisely the channel
      the brief said would justify revisiting the gap — "both announced and
      un-photographable" — so brief and IA are updated rather than left
      claiming a mitigation that did not work. It outlives teardown by 4s,
      because its most important message is said *at* teardown, and it removes
      any lingering predecessor so remounts cannot stack announcers.
      Per-tile progress is still not announced: a polite region firing twelve
      times is chatter, not information.
      **Also verified in the running UI**, not from Phase 4 arithmetic: the
      disabled control holds focus, shows a focus ring, is greyed by colour
      with `opacity: 1`, and `--nc-text-disabled` clears 4.5:1 against all
      three grounds it can sit on — surface, hover surface, and glass over a
      white page — computed from the live stylesheet via probe elements the
      browser resolves. `forced-colors: active` hands both the disabled colour
      and the accent to the OS palette. Preview 173 → 189.

- [x] **T15 · Token drift guard**: `tools/test-tokens.mjs` parses the four
      `--nc-badge-*` values out of `tokens.css` and the corresponding constants
      out of `background.js`, and fails if they disagree. Wire into
      `tools/test.sh`. A convention would not hold this; a red test will.
      _New file. Depends on: T6._
      **Built, and marked `[x]` rather than `[~]`** — this is the one task in
      this list with no runtime behaviour to verify in a browser. It is a
      static check over two files; the suite passing *is* its acceptance test.
      19 checks. Resolves `var()` chains, so the comparison survives
      `--nc-badge-progress: var(--nc-accent)` rather than comparing the literal
      string `var(--nc-accent)` to a hex value and calling it a mismatch.
      **Proved by breaking it, five ways**, each caught:
        1. change a token, leave the worker;
        2. change the worker, leave the token;
        3. change the token it points *through* (`--nc-accent`) — the subtle
           one, where retuning the brand purple silently desyncs the badge and
           nothing else in the codebase would notice;
        4. reintroduce a raw hex literal in `background.js` outside `BADGE`,
           which is the shape the pre-existing 3.41:1 failure badge had;
        5. add a `--nc-badge-*` token nobody wired up — a token nothing paints
           with is its own kind of rot.
      The key mapping is spelled out rather than derived from the names, so a
      rule that turns `progressText` into `--nc-badge-progress-text` cannot
      also silently bless a fifth constant with no token behind it.

- [~] **T16 · Docs correction**: `README.md:78` still says
      "**Capture full screen** takes the whole viewport" — rewrite for both
      capture modes, the cap, and the badge. Update `README.md:197`
      ("Full page is a PDF") which this feature makes false. Regenerate
      `preview/` shots showing the new pill.
      _Depends on: T8, T9._
      **Built.** Usage section rewritten for both capture modes. Added an
      "About full page" section stating the things a user would otherwise
      discover by being surprised: roughly half a second per screenful and why,
      the badge counter, the lazy-load sweep, sticky headers appearing once,
      Esc cancelling with everything restored, the 16384px cap, and the
      disabled-on-short-pages case.
      `README.md:197` said **"Full page is a PDF, as in Opera — not a
      scroll-stitched PNG"** in a list of deliberate omissions. This feature
      makes that false, so it is replaced with what is *actually* still out of
      scope: horizontal stitching, inner scrollers, per-tile screen-reader
      progress, and infinite feeds.
      Status section: test counts corrected to 435 unit + 189 browser, and the
      stale "fallback editor is still being rebuilt" claim removed — with a
      note that browser checks are not a substitute for Brave and that the task
      list tracks which behaviours have been verified there. File tree gains
      `fullpage.js` and `stitch.js`.
      Previews regenerated. The README hero now renders against the **tall**
      fixture: its first viewport is identical to the short one, but it has
      something below the fold, so the product shot shows both capture modes
      live instead of one greyed out.

## Review

- [x] **T17 · Design review**: run `/design-review` against
      `.design/capture-modes/DESIGN_BRIEF.md`.
      **Done.** `.design/capture-modes/DESIGN_REVIEW.md`, with ten screenshots
      from a real Chromium at 375/768/1280 plus the states unique to this
      feature. `tools/review-shots.mjs` is checked in so the set can be
      regenerated rather than re-described.
      **Two must-fix findings, both found and fixed during the review, and
      neither visible to 190 passing browser checks:**
      (a) `overlay.css` had no `forced-colors` block at all, so in Windows High
      Contrast the OS overrode every swatch background and all seven inks
      rendered as identical empty circles — the palette stopped being a palette
      for precisely the users most likely to be in that mode.
      (b) The `< 640px` label collapse also hit the rail's **Copy** and
      **Save**, reducing the two controls the overlay exists to reach to a
      purple square and a downward arrow while every tool beside them kept an
      icon that was always its whole identity. The existing test for this
      asserted the opposite intent and passed, because it queried the first
      `.nc-btn__label` in the shadow root — the rail's, not the pill's.
      Both are fixed; the second is now scoped with a companion check.
      Three should/could items are recorded and not fixed, the largest being
      sub-44px touch targets in the rail (the `--nc-handle-hit` pattern already
      in this codebase is the cheap remedy if 375px is a width this tool means
      to support properly).

- [ ] **T18 · Browser verification matrix** — **the only task left, and the
      only one that needs a human.** Everything above is `[~]`: unit-tested and
      driven in headless Chromium, but never loaded as an extension in Brave.
      Nothing reaches `[x]` until it appears here.

      Load it: `brave://extensions` → Developer mode → *Load unpacked* → this
      folder. Then `Ctrl+Shift+5` on each page below.

      | # | Page | Do | Expect |
      |---|---|---|---|
      | 1 | any ordinary site | Frame a region, press **Copy**, **from a cold service worker** (reload the extension first) | Lands on the clipboard first press. **No `Copy failed`.** Repeat ten times from cold — this is the original bug |
      | 2 | same | Paste into an image editor | A real image, not HTML. If the pill said *Copied as HTML*, rung 1 was refused — tell me, that is a different bug |
      | 3 | a page shorter than the window | Open the pill | `Capture full page` **disabled**, hint reads `Whole page already visible`, still reachable by Tab |
      | 4 | a long article | **Capture full page** | Badge counts `1/N`; editor opens with the whole page stitched. **Watch the console for `ms/tile`** |
      | 5 | — | — | **If `ms/tile` > 1000, stop and tell me.** T3's abort condition is still open and nine tasks rest on that number |
      | 6 | a page with a sticky header | Capture full page | Header appears **once**, at the top — not banding down every screenful |
      | 7 | a page with lazy images | Capture full page | No blank placeholders |
      | 8 | a page whose height is an exact multiple of the window, and one that is not | Capture full page | No seam, no duplicated band, no blank strip at the bottom |
      | 9 | a very long page (30 000px+) | Capture full page | Editor opens with `Full page capped at …px — page is longer` in amber |
      | 10 | any long page | Press **Esc** mid-capture | Scroll position back exactly where it was, sticky header back, badge cleared, overlay still up with the original capture intact |
      | 11 | any long page | Start a capture, then switch tabs and come back | It finishes or fails cleanly; no badge left counting |
      | 12 | `brave://settings` | `Ctrl+Shift+5` | Editor window opens with the viewport capture; **no** capture buttons in its pill |
      | 13 | any page, Windows High Contrast on | Frame a region | Seven **distinct** ink colours in the rail, selected ink outlined |
      | 14 | any page | Narrow the window under 640px, frame, copy | **Copy** and **Save** keep their labels; a degraded copy shows `Copied as HTML` in amber |

      Rows 1, 4, 5 and 10 are the ones that matter most: row 1 is the bug you
      reported, rows 4–5 are the assumption the whole full-page half rests on,
      and row 10 is the invariant that leaves the page as it was found.
