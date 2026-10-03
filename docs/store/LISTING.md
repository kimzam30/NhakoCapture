# Chrome Web Store listing: NhakoCapture 2.2.0

Everything the developer dashboard asks for, in the order it asks. Copy each
block into the matching field. The text blocks are plain text on purpose: the
store doesn't render Markdown, so bullets are `•` and headings are capitals.

Upload: `dist/NhakoCapture-2.2.0.zip`, built by `./tools/package.sh`.

---

## 1. Package → Store listing tab

### Item name
Taken from `manifest.json`: **NhakoCapture**

> Optional, for search: the store ranks heavily on the name. A descriptive
> suffix is allowed if it isn't keyword stuffing, for example
> `NhakoCapture: Screenshot & Markup`. That means changing `"name"` in
> `manifest.json` and rebuilding the zip. It's your call. The plain name is
> fine.

### Summary (from the manifest, 124 / 132 characters)
```
Screenshot any part of a page, mark it up with arrows, blur and text, then copy or save. Full-page capture too. No tracking.
```

### Description
```
Screenshot anything. Never leave the tab.

NhakoCapture is a screenshot tool that works right on the page. Press one shortcut and the page holds still. Drag a box around what matters, draw an arrow on it, blur the bits nobody else should see, and it's on your clipboard, ready to paste. No new tab, no separate editor, no account.

HOW IT WORKS
1. Press Ctrl+Shift+5 (⌘+Shift+2 on a Mac), or click the butterfly in your toolbar.
2. The page freezes. Drag over anything to frame it, or pick Visible area or Whole page.
3. Mark it up with the tool bar that appears underneath.
4. Hit Copy to paste it anywhere, or Save to choose where the file goes.

MARK IT UP RIGHT THERE
• Annotate your screenshot with pen, arrow, highlighter and text, right on top of the page you're already looking at
• Seven colours and three line widths
• A magnifier for the fiddly bits
• Undo and redo every mark, all the way back to the start
• Fine-tune the frame with eight handles or the arrow keys. A small label shows the real size of the image you'll get.

BLUR THAT REALLY HIDES THINGS
Blur replaces the pixels with a blurred copy of themselves. It isn't a see-through box on top, so nobody can un-blur the screenshot you share. Use it on emails, names, card numbers and anything else that isn't yours to share.

THE WHOLE PAGE, IN ONE IMAGE
• Whole page takes a full-page screenshot: it scrolls for you and stitches every screenful into one tall image
• Sticky headers, cookie banners and chat bubbles appear once, not on every screenful
• Pictures that only load as you scroll are there in the final image
• The toolbar icon counts along while it works, and Esc stops it
• Switching tabs pauses the capture, so it never stitches in the wrong tab
• Save as PDF sends the whole page to your browser's print preview, with Save as PDF ready to go

PRIVATE BY DESIGN
• No account, no sign-up, no login
• No network requests: no screen capture is ever uploaded, and it works offline
• No analytics, no ads, no trackers
• Screenshots go to your clipboard or the folder you choose, and nowhere else
• It only works on a tab when you press the shortcut or click the icon

KEYBOARD SHORTCUTS
• Ctrl+Shift+5 / ⌘+Shift+2: open or close NhakoCapture
• P, A, B, H, T, Z: pen, arrow, blur, highlighter, text, magnifier
• Ctrl+Z / Ctrl+Shift+Z: undo and redo
• Ctrl+C: copy and close
• Ctrl+S: save and close
• Arrow keys: nudge the frame (Shift for 10 pixels, Alt to resize)
• Esc: one step back

If another extension already uses the shortcut, change it at chrome://extensions/shortcuts.

GOOD TO KNOW
• Works in Chrome, Brave, Edge and other Chromium browsers, version 116 or newer
• On the browser's own pages, where extensions can't draw, your capture opens in a small editing window with the same tools
• Very long pages are cut off at 16,384 pixels tall rather than shrunk into a blur, and the editor tells you when that happens

NhakoCapture is part of the Nhako family, alongside Nhako Tools and NhakoSearch: free, private, and made to feel good to use.

Open source: https://github.com/kimzam30/NhakoCapture
```

### Category
**Productivity → Tools**

### Language
**English**

### Graphic assets
| Field | File | Size |
|---|---|---|
| Store icon | `icons/icon128.png` | 128 × 128 |
| Screenshot 1 | `docs/store/screenshot-1-hero.png` | 1280 × 800 |
| Screenshot 2 | `docs/store/screenshot-2-markup.png` | 1280 × 800 |
| Screenshot 3 | `docs/store/screenshot-3-blur.png` | 1280 × 800 |
| Screenshot 4 | `docs/store/screenshot-4-whole-page.png` | 1280 × 800 |
| Screenshot 5 | `docs/store/screenshot-5-private.png` | 1280 × 800 |
| Small promo tile | `docs/store/promo-small-440x280.png` | 440 × 280 |
| Marquee promo tile | `docs/store/promo-marquee-1400x560.png` | 1400 × 560 |

All are 24-bit PNG with no transparency, which the store requires. The
product shots inside them are drawn by the extension's own code
(`tools/store-shots.mjs`), not mocked up.

### Additional fields
| Field | Value |
|---|---|
| Official URL | (leave empty unless you verify a domain in Search Console) |
| Homepage URL | `https://github.com/kimzam30/NhakoCapture` |
| Support URL | `https://github.com/kimzam30/NhakoCapture/issues` |
| Mature content | No |

---

## 2. Privacy tab

### Single purpose description
```
NhakoCapture takes screenshots of the current tab and lets the user frame, annotate, blur and then copy or save them. Every feature (visible-area capture, whole-page capture, markup tools and Save as PDF) serves that one purpose of capturing what is on the page.
```

### Permission justifications

**activeTab**
```
Captures the tab the user is on with tabs.captureVisibleTab, and only after the user presses the keyboard shortcut or clicks the toolbar icon. No other tab is ever accessed.
```

**scripting**
```
Injects the capture overlay (the frame, markup tools and toolbar) into the active tab after the user starts a capture, and opens that tab's print preview when the user chooses Save as PDF. Scripts are only injected into the tab granted by activeTab.
```

**storage**
```
Passes a single captured image to the extension's own editing window, which is used on pages where the overlay cannot run and for whole-page captures. The entry is removed from storage as soon as the window reads it. Nothing else is stored.
```

**offscreen**
```
Creates an offscreen document to write images to the clipboard on plain http:// pages, where the page itself has no Clipboard API, and to create blob URLs for downloads, which a service worker cannot do.
```

**downloads**
```
Saves the user's screenshot with chrome.downloads.download and saveAs: true, so the user picks the folder and file name in the browser's Save dialog.
```

**Host permissions**: none requested.

### Remote code
**No, I am not using remote code.**
```
All JavaScript is packaged in the extension. No code is loaded from any server, and there is no eval or new Function.
```

### Data usage
Tick **none** of the data categories. NhakoCapture collects no personally
identifiable information, health, financial, authentication, personal
communications, location, web history, user activity or website content.
(Screenshots are processed locally and never transmitted. Under the store's
definition, "collecting" means transmitting off the device or keeping it.)

Then tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL
```
https://github.com/kimzam30/NhakoCapture/blob/main/PRIVACY.md
```
(This works once `PRIVACY.md` is pushed and the repository is public.)

---

## 3. Distribution tab
| Field | Suggested |
|---|---|
| Payments | Free |
| Visibility | Public |
| Regions | All regions |

---

## 4. Before you press Submit
- [ ] `./tools/package.sh` ran clean and built `dist/NhakoCapture-2.2.0.zip`
- [ ] Load the zip's contents unpacked once in Chrome and try: shortcut, drag, every tool, Copy, Save, Whole page, Save as PDF
- [ ] `PRIVACY.md` is pushed and the GitHub repository is public, so the privacy policy URL opens
- [ ] The developer account's contact email is verified (Account tab)
- [ ] All graphic assets uploaded in the order above (screenshot 1 is the one people see first)

First reviews typically take a few days. With no host permissions and no
`debugger`, this one avoids the extra scrutiny broad permissions trigger.
