# Design Tokens

The token file is **`src/overlay/tokens.css`** — it lives with the code that
consumes it rather than here, so there is exactly one source of truth and no
design-folder copy to drift out of sync.

It is loaded by `src/background.js`, which reads it from the extension bundle
and passes the text to the overlay in the `nc:start` handoff. The overlay adopts
it into its shadow root as a constructable stylesheet. It is deliberately *not*
fetched by the content script: a service worker can always read its own
resources, which avoids both `web_accessible_resources` and any interaction with
the host page's CSP.

Two things about that file worth knowing before editing it:

- **Tokens declare on `:host`, not `:root`.** Custom properties inherit through a
  shadow boundary — the one thing Shadow DOM does not isolate — so a page
  defining its own `--space-4` would otherwise reach in and move our layout.
- **`--nc-accent` (`#8a2be2`) may not be used for borders, focus rings or active
  indicators on the dark chrome.** It measures 2.80:1 there and fails WCAG
  1.4.11's 3:1 floor for non-text UI. `--nc-accent-bright` (`#a862ea`, 4.45:1)
  exists for those jobs.

See `DESIGN_BRIEF.md` § Accessibility Requirements for every measured ratio.
