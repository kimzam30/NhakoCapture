# Design Tokens: Capture Modes

Feature slug: `capture-modes`
Token file: `src/overlay/tokens.css` (extended, not replaced)
Philosophy: Functional browser chrome (Swiss / utilitarian) — inherited
Date: 2026-08-25

## What this phase did

Nothing was generated from scratch. `src/overlay/tokens.css` is a complete,
computed system from `opera-snapshot-parity`: accents with a documented
non-text-contrast token, four surfaces, three text weights, spacing on a 4px
base, a type ramp, motion, layering, plus `prefers-reduced-motion` and
`forced-colors` branches. It needed extending in exactly four places.

**The no-light-mode deviation is upheld.** The standard token brief asks for
light and dark palettes; this file argues, correctly, that a translucent chrome
overlay floating above someone else's page must be pinned dark to read as *the
browser doing something* rather than as part of the page. Nothing in this
feature changes that, so no `prefers-color-scheme` branch was introduced.

## Added

| Token | Value | Why it could not reuse an existing token |
| --- | --- | --- |
| `--nc-text-disabled` | `#9a9a9a` | See below — the load-bearing addition. |
| `--nc-notice` | `var(--nc-warning)` | The cap notice outranks the toolset in the brief's content hierarchy. Sharing `--nc-text-muted` with ordinary hints would rank it *below*. |
| `--nc-badge-progress` / `-text` | `var(--nc-accent)` / `#ffffff` | New surface. 5.96:1. |
| `--nc-badge-error` / `-text` | `var(--nc-error)` / `#1c1c1e` | New surface, and it fixes a live bug — see below. |

Plus `--nc-text-disabled: GrayText` in the `forced-colors` branch, so Windows
High Contrast paints the disabled state with the OS's own disabled colour rather
than our grey, which that mode would otherwise flatten into the surface.

## The disabled-text decision

`--nc-text-faint` (3.57:1) already exists and is annotated "disabled states and
dividers only". Reusing it would have been the obvious move and it is the wrong
one, for a reason specific to this feature.

WCAG 1.4.3 **exempts inactive components** from the contrast minimum. That
exemption is why `--nc-text-faint` on a greyed undo button is conformant: a user
who cannot read it loses nothing, because a disabled undo says only "nothing to
undo", which the interface has already communicated by disabling it.

`Capture full page` when disabled is a different animal. You chose in Phase 2 to
render it disabled *specifically so it teaches* — so the user learns the
visible/full distinction at the moment it is relevant. Its label and its reason
are the entire payload. Leaning on the exemption here would satisfy the letter of
the standard and defeat the purpose of the control, leaving exactly the dead
button the toolbar's original rule forbids. So it gets a token that clears 4.5:1.

**Solid, not an alpha.** Every other text token in the file is `rgba(255,255,255,α)`.
That works because those sit on known opaque surfaces. `.nc-btn` has
`background: transparent` and the pill is `--nc-surface-glass` at 0.92 alpha, so
8% of whatever page is underneath bleeds through and the effective ground moves.
An alpha token's contrast would move with it. Ratios, computed against all three
grounds the control can actually sit on:

| Ground | `#9a9a9a` | `--nc-text-faint` for comparison |
| --- | --- | --- |
| `--nc-surface` `#1e1e1e` | **5.92:1** | 3.57:1 |
| `--nc-surface-raised` `#2d2d2d` (hover) | **4.89:1** | 3.35:1 |
| glass over a white page `#303030` (worst case) | **4.69:1** | 3.30:1 |

`#969696` was the first candidate and was rejected at 4.46:1 on the worst-case
ground — under the floor by 0.04.

**Do not implement the disabled state with `opacity`.** It is the reflexive way
to grey a control and it would drag this token back below the floor, along with
the icon and the focus ring. Colour only.

## A live bug this phase found

`background.js` sets the failure badge to `#ff453a` and lets Chrome choose the
text colour. Chrome defaults badge text to **white**, and white on that red is
**3.41:1** — under 4.5. It has presumably always been that way; nothing surfaced
it because nobody had computed it.

`--nc-badge-error-text: #1c1c1e` fixes it at **6.16:1**, and both badge states
now set their text colour explicitly rather than inheriting a default. This is
outside the feature's stated scope but is a two-line fix in code this feature is
already editing, so it rides along rather than being left for a phase that may
never come.

## Drift risk, and the guard

Badge colours are applied through `chrome.action.setBadgeBackgroundColor` from a
service worker, which has no CSS and cannot read this file. The values therefore
exist in two places, which is exactly how tokens rot.

The guard is a test, not a convention: `tools/test-tokens.mjs` (built in Phase 6)
parses the four badge tokens out of `tokens.css`, parses the constants out of
`background.js`, and fails if they disagree. Documenting the rule would not have
held; a red test will.

## Not added, deliberately

- **Motion tokens for the badge.** The badge counter ticks roughly twice a
  second and browser chrome does not animate. Nothing to tween.
- **A progress-fill or bar token.** The bar was rejected at Phase 2 and the
  counter moved to browser chrome at Phase 3. No in-page progress surface exists
  to need tokens.
- **A `--nc-surface-disabled`.** The disabled button keeps `transparent` and
  simply does not paint a hover ground. Adding a disabled surface would make it
  *more* visually prominent than the enabled buttons beside it, which are also
  transparent at rest.
- **Spacing or type additions.** Three pill actions plus dismiss fit the existing
  4px scale and the existing 13px `--nc-text-base`.
