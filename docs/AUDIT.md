# NhakoCapture audit, 2026-10-21

Scope: the whole repo at `44e432a`. The audit looked at bugs, dead code, stale
assets and Firefox portability. Fixes went in only where they were safe and
covered by tests. Everything else is listed below for later.

## Branches

`dev`, `main` and `origin/main` all point to the same commit (`44e432a`), so
there was nothing to compare between them. All of the work below sits
uncommitted on `dev`.

## Checks

| | Before | After |
|---|---|---|
| Unit tests (8 suites) | 475 passed | 494 passed (19 new) |
| Browser integration (`tools/preview.mjs`) | 218 passed | 218 passed |
| New `test.sh` steps | n/a | Firefox manifest, and `<script>` paths in `offscreen.html` / `editor.html` |
| `web-ext lint` on the Firefox build | n/a | 0 errors, 2 warnings (Chrome-only offscreen calls that never run in Firefox) |

## Fixed

| Severity | Where | Problem | Fix |
|---|---|---|---|
| High | `background.js`, `openEditorWindow` | Each handoff wrote only its own storage keys and left the previous ones beside them. The editor prefers `capturedImage`, so a whole-page blob could be dropped and never revoked, which kept the offscreen document alive for good. A stale `captureCapped` could also label a normal capture "cut off". | Clear all three keys before writing, and revoke a blob that is being replaced. Tested. Since replaced by per-window nonces (follow-up item 1 below). |
| Medium | `background.js`, `askOffscreen` | The 30s idle-close timer was only reset after a reply came back, so it could close the document in the middle of a large `make-blob-url`. | Clear the timer when the request starts. |
| Medium | `background.js`, `launch` | Any capture error, including a double press that hits the rate limit, was reported as "the browser keeps its pages off-limits". | A rate-limit error now says "pressed too quickly — try again". Tested. |
| Medium | `inject.js`, whole page | A canvas past the browser's size or memory limit encodes to `"data:,"`, which opened an empty editor window. | Detect this and show "That page is too big to capture in one image". |
| Low | `inject.js`, `finish()` | After an `await`, it only checked that some session existed, so if the overlay was torn down and restarted it could change the new session. | Compare against the session that started the copy. |
| Low (Firefox) | `stage.js`, `adoptStyles` | Firefox content scripts can refuse a constructed stylesheet through Xray wrappers, which would leave the overlay unstyled. | Use try/catch and fall back to a `<style>` element. |
| Lint | `toolbar.js`, `rail.js` | 6 `innerHTML` writes. Firefox's add-on review flags every one. | Build the icons as DOM nodes with `NC.svg()` (DOMParser plus importNode). No visual change. |
| Brand | `toolbar.js`, `overlay.css` | The pill still drew the old butterfly and played a "wingbeat" animation. | Draw the pixel camera mascot on a 12px grid, with a small hop animation. Reduced-motion is still respected. |

## Firefox port

- `tools/firefox-manifest.py` derives the Firefox manifest from `manifest.json`.
  It switches to `background.scripts`, drops `offscreen`, adds
  `clipboardWrite`, and adds the `gecko` block: ID, `strict_min_version`
  140.0, and the data-collection declaration.
- `src/offscreen.js` now has a single `ncOffscreenHandle(msg)` entry point. In
  Chrome the offscreen document reaches it through a message listener. In
  Firefox it is loaded into the background page and `background.js` calls it
  directly.
- `tools/package.sh [chrome|firefox|all]` builds the zips.
- The `isRestricted` check now covers Firefox's own pages: `resource:`,
  `jar:`, addons.mozilla.org, accounts.firefox.com and support.mozilla.org.
- The step-by-step publishing guide is [`docs/store/FIREFOX.md`](store/FIREFOX.md).

## Cleanup

- **Untracked `.design/`.** It was listed in `.gitignore` but 18 of its files
  were still committed. Your local copy is untouched.
- **Removed unused module exports:** `render.drawOp`, `selection.DIRECTIONS`,
  `stage.HOST_ID`, `fullpage.FOLD_SLACK`, `clipboard.supported`, and the
  module-level `rail.TOOLS`/`INKS` and `annotate.SIZES`. The instance copies
  that are actually used are kept.
- **Removed 11 orphan design tokens:** `--nc-accent-active`,
  `--nc-border-focus`, `--nc-pink-soft`, `--nc-lavender`, `--nc-success`,
  `--nc-font-mono`, `--nc-blur-radius`, `--nc-highlight-alpha` and
  `--nc-stroke-thin`/`-medium`/`-thick`. The stroke values are hard-coded in
  `annotate.js`. The unused steps of the complete type, spacing, z-index and
  duration scales are kept on purpose, so each scale stays whole.
- **README:** the butterfly is gone from the design section and the image alt
  text, there are new Firefox release notes, a `clipboardWrite` row in the
  permissions table, and a "What's new in 2.3" section. The 2.1 changelog
  still mentions the butterfly; that is history and was left alone.
- **Version** bumped to 2.3.0, because both stores refuse a version they have
  already seen.

## Follow-up fixes

Items 1–3 of the list below were fixed afterwards. Unit tests went from 494
to 518 passed (24 new). The browser integration checks still pass (218), and
their editor shims now read from `storage.session` under the URL's nonce.

| Severity | Where | Problem | Fix |
|---|---|---|---|
| High | `background.js` `openEditorWindow`, `fallback/editor.js` `main` | Handoffs went through `storage.local`, so every screenshot was written to disk. They also shared one fixed set of keys, so a second capture could overwrite the first before its window had read it. | Each handoff goes into `storage.session` under `nc-editor:<nonce>`, and the nonce is in the editor URL's fragment. Each window can only read its own. Closing an editor window drops a handoff it never read and revokes a blob it never decoded. Tested on both the Chrome and the in-process Firefox paths. |
| Medium | `background.js`, offscreen idle-close and downloads | `outstandingBlobs` and `pendingDownloads` lived only in memory. A worker evicted while a Save As dialog was open woke up with nothing recorded: it could close the offscreen document under the dialog, and it never revoked the blob. | Both now live in `storage.session` (`nc-outstanding-blobs`, a list of URLs, and `nc-pending-downloads`). The idle close and `downloads.onChanged` read them from there, and updates go through a queue so they can't overwrite each other. Tested by loading a second background against the same session store. |
| Low | `background.js`, `askOffscreen` | It retried on "message port closed". That error means the message was delivered, so a retry could mint a second blob that nothing revokes. | It now retries only on "Receiving end does not exist" or "Could not establish connection". The readiness ping still treats a closed port as not-yet, because a ping has no effect to double. Tested. |

## Not fixed (worth doing next)

1. ~~**Move editor handoffs to `storage.session`**~~ Fixed, see
   [Follow-up fixes](#follow-up-fixes).
2. ~~**Blob and download state is lost when the worker is evicted.**~~
   Fixed, see [Follow-up fixes](#follow-up-fixes).
3. ~~**"message port closed" retries**~~ Fixed, see
   [Follow-up fixes](#follow-up-fixes).
4. **Clipboard race** (`clipboard.js`). After the 3s timeout, the page's write
   keeps running alongside the offscreen fallback, and whichever finishes last
   wins.
5. **Offscreen rung 1 always fails** (a document that never has focus), so on
   http:// pages every copy tries one dead write before falling back to HTML.
6. **Peak memory on whole-page captures.** About three copies of a ~48MB data
   URL exist at once (page → worker → offscreen). Release the canvases after
   the handoff and send the image in chunks over a port. On Firefox,
   `tabs.captureTab(tabId, { rect })` could capture the whole document without
   scrolling.
7. **Firefox's own screenshot shortcut is Ctrl+Shift+S.** There is no clash,
   but the listing could mention it.

## Stale assets

- `docs/screenshot.png` and `docs/launch/*` (poster, videos) still show the
  butterfly brand. Redo them after the store graphics.
- `docs/store/*` has been redone in the pixel-mascot style in a separate
  session.
- `tools/review-shots.mjs` isn't referenced anywhere and writes into the
  now-untracked `.design/`. Keep it as a local design tool, or delete it.
- `docs/store/raw/`, `docs/launch/*.mp4` and `soundtrack.wav` are build
  outputs. Consider gitignoring them or moving them to Git LFS.
