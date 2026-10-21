# Publishing NhakoCapture on Firefox (addons.mozilla.org)

This guide goes from the repo to a public listing on AMO (addons.mozilla.org).
Most of the work is already done: `./tools/package.sh firefox` builds a zip
that passes Mozilla's linter. What's left is testing it in Firefox and filling
in the AMO forms.

The text you paste into AMO comes from [`LISTING.md`](LISTING.md). The
differences for Firefox are under step 5.

---

## How the Firefox build differs

You don't maintain a second codebase. `manifest.json` stays the Chrome
manifest, and `tools/firefox-manifest.py` derives the Firefox one from it each
time you package:

| | Chrome | Firefox |
|---|---|---|
| Background | `service_worker: src/background.js` | `scripts: [src/offscreen.js, src/background.js]`. Firefox runs an event page with a DOM, not a service worker |
| Clipboard and blob URLs | An offscreen document (`src/offscreen.html`) | The same `offscreen.js` code, called directly inside the background page |
| Permissions | `offscreen` | `clipboardWrite` in place of `offscreen` |
| Extra keys | `minimum_chrome_version: 116` | `browser_specific_settings.gecko`: an ID, `strict_min_version: 140.0`, and `data_collection_permissions: { required: ["none"] }` |

The add-on ID is `nhakocapture@kimzam30.github.io`. **Never change it after
the first upload.** AMO ties the listing, the signing and every user's updates
to that ID.

Why Firefox 140 is the minimum: since 3 November 2025 every new AMO listing
must declare what data it collects, and Firefox has only shown that consent
screen since version 140. 140 is also the current ESR (the extended-support
release), so this excludes almost nobody.

---

## 1. Build and lint

```bash
./tools/package.sh firefox
```

This runs every check, then writes `dist/NhakoCapture-<version>-firefox.zip`.
`./tools/package.sh all` builds the Chrome and Firefox zips together from the
same version number.

Then run Mozilla's own linter. It is the same one AMO runs on upload:

```bash
mkdir -p /tmp/nc-ff && rm -rf /tmp/nc-ff/* && unzip -q dist/NhakoCapture-*-firefox.zip -d /tmp/nc-ff
```

```bash
npx web-ext lint -s /tmp/nc-ff
```

Expect **0 errors and 2 warnings**, both `UNSUPPORTED_API` for
`offscreen.createDocument` and `offscreen.closeDocument`. Those calls are
Chrome-only and never run in Firefox, because `background.js` checks for
`chrome.offscreen` first. Warnings don't block a submission. Mention them in
the reviewer notes (step 5).

## 2. Try it in Firefox before you submit

Firefox isn't installed on this machine, so I haven't run this build in a
real Firefox yet. Do this pass yourself before you submit.

Install Firefox 140 or newer, then do either of the following:

- **Quickest:** open `about:debugging#/runtime/this-firefox`, click **Load
  Temporary Add-on…** and pick `manifest.json` inside `/tmp/nc-ff`. It stays
  loaded until Firefox restarts.
- **With live reload:** run the command below. It opens a clean Firefox
  profile with the add-on installed.

  ```bash
  npx web-ext run -s /tmp/nc-ff
  ```

Then run the same checklist as for Chrome:

- [ ] Ctrl+Shift+5 (⌘+Shift+2 on a Mac) opens the overlay. If it doesn't, open
      `about:addons` → gear icon → **Manage Extension Shortcuts** and check for
      a conflict.
- [ ] Drag a frame, and use every tool: pen, arrow, blur, highlighter, text,
      magnifier, undo and redo.
- [ ] **Copy**, then paste into an image editor (GIMP, or a Google Doc). That
      proves a real PNG reached the clipboard.
- [ ] **Copy** on a plain `http://` page, for example `http://neverssl.com`.
      This copy goes through the background page.
- [ ] **Save** opens the Save dialog. Leave the dialog open for more than 30
      seconds, then save. Firefox can suspend an idle event page, and the file
      should still save. If it fails, tell me: the fix is to hand the download
      a blob made in the editor window instead.
- [ ] **Whole page** on a long page (a Wikipedia article): the badge counts up,
      the editor window opens, and the stitched image looks right.
- [ ] **Save as PDF** opens the print dialog. Firefox calls its PDF option
      "Save to PDF".
- [ ] Try it on a site with a strict Content Security Policy (github.com). The
      overlay should still be styled, not plain unstyled HTML.
- [ ] On `about:` pages and addons.mozilla.org the capture should open in the
      small editing window, or show the "can't capture" badge. Firefox doesn't
      let extensions draw on either.

## 3. Create your AMO developer account

1. Go to <https://addons.mozilla.org/developers/> and sign in with a Mozilla
   account. Create one with your usual email if you don't have one.
2. Accept the **Firefox Add-on Distribution Agreement** the first time you
   submit. Read it yourself; I can't accept it for you.
3. Optional but recommended: set a display name and a homepage on your
   developer profile. They appear on the listing as "by …".

## 4. Submit the add-on

1. Open **Submit a New Add-on** in the Developer Hub.
2. **How to distribute:** choose **On this site**. That lists it publicly on
   AMO. "On your own" only signs the file for you to host yourself.
3. **Upload** `dist/NhakoCapture-<version>-firefox.zip`. AMO runs the linter
   again and shows the same 2 warnings. Continue.
4. **Compatibility:** tick **Firefox** only. Leave Firefox for Android off for
   now: the overlay hasn't been designed for touch.
5. **Source code:** answer **No**. AMO only asks for source when the code is
   minified, bundled or generated. NhakoCapture ships its source as-is (no
   bundler), which also makes review faster.

## 5. Fill in the listing

| AMO field | What to put |
|---|---|
| Name | `NhakoCapture` |
| Add-on URL | `nhakocapture` (gives `addons.mozilla.org/firefox/addon/nhakocapture`) |
| Summary (250 characters max) | The manifest description from `LISTING.md` → Summary (124 characters) |
| Description | `LISTING.md` → Description, with the Firefox changes below |
| Categories | **Photos, Music & Videos** and **Productivity** (AMO allows two) |
| Support email / website | `https://github.com/kimzam30/NhakoCapture/issues` |
| License | **MIT License** (matches `LICENSE`) |
| Privacy policy | Paste the text of `PRIVACY.md`. AMO wants the text itself, not a link. |
| Tags | `screenshot`, `screen capture`, `annotate`, `full page`, `privacy` |

**Changes to the description for Firefox:**

- In GOOD TO KNOW, replace "Works in Chrome, Brave, Edge and other Chromium
  browsers, version 116 or newer" with **"Works in Firefox 140 or newer."**
- Replace "change it at chrome://extensions/shortcuts" with **"change it in
  about:addons → gear icon → Manage Extension Shortcuts."**
- "Save as PDF sends the whole page to your browser's print preview" is
  already accurate for Firefox.
- AMO renders a little formatting, but the plain text with `•` bullets from
  `LISTING.md` looks fine as it is.

**Data collection:** the manifest already declares `none`. AMO reads that, and
Firefox shows users "This add-on doesn't collect any data" at install. You
don't need to declare anything else.

**Notes for reviewers** (the field only reviewers see):

```
No build step: the uploaded files are the source (https://github.com/kimzam30/NhakoCapture).
The two UNSUPPORTED_API warnings (offscreen.createDocument / closeDocument) are
Chrome-only code paths. background.js checks `typeof chrome.offscreen` and, in
Firefox, calls the same jobs from src/offscreen.js directly in the background
page instead. No remote code, no network requests, no eval. Permissions:
activeTab + scripting (draw the overlay on the tab the user invoked it on),
downloads (Save dialog), storage (one-shot handoff to the editor window),
clipboardWrite (copy the screenshot).
To test: press Ctrl+Shift+5 on any web page, drag a box, press Copy.
```

## 6. Images

AMO has no promo tiles. It wants an icon and screenshots:

| Asset | File | Notes |
|---|---|---|
| Icon | Taken from the zip (`icons/icon128.png`) | Nothing to upload |
| Screenshots | `docs/store/firefox/*.png`, or the Chrome ones in `docs/store/` | AMO shows them at up to **1280×800**. Keep the 1.6:1 ratio. Add a caption to each. |

Upload the hero screenshot first. Suggested captions:

1. Screenshot anything. Never leave the tab.
2. Arrows, pen, highlighter and text, right on the page.
3. Blur that really hides things.
4. The whole page, stitched into one image.
5. No account, no tracking, works offline.

## 7. After you submit

- **Review:** automatic validation is immediate. A human reviewer may look at
  it within a few days; small add-ons with no host permissions are usually
  quick. You get an email either way.
- **Once approved,** it's live at `addons.mozilla.org/firefox/addon/nhakocapture`.
  Add the badge to the README beside the Chrome one.
- **If it's rejected,** the email says why. Reply in the Developer Hub's review
  thread and upload a fixed version.

## 8. Releasing updates to both stores

1. Bump `"version"` in `manifest.json`. Both stores refuse a version number
   they've already seen.
2. Build both zips:

   ```bash
   ./tools/package.sh all
   ```

3. Chrome: upload `dist/NhakoCapture-<v>.zip` in the Chrome developer
   dashboard.
4. Firefox: in the Developer Hub, open NhakoCapture → **Upload New Version**,
   then upload `dist/NhakoCapture-<v>-firefox.zip`.

Firefox users get the update automatically once it's approved.
