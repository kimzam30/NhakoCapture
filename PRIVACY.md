# NhakoCapture privacy policy

_Last updated: 3 October 2026_

NhakoCapture is a screenshot tool that runs entirely in your browser. This
page explains what it handles and what it doesn't.

## What NhakoCapture collects

Nothing. NhakoCapture doesn't collect, store, sell or share any personal
information, and it has no servers to send anything to.

- **No network requests.** The extension never connects to the internet. It
  has no analytics, no crash reporting, no ads and no remote code.
- **No account.** There's nothing to sign up for and nothing to log in to.
- **No browsing history.** NhakoCapture can't see which sites you visit. It
  only works on a tab when you press its shortcut or click its icon, and only
  on that tab.

## What happens to your screenshots

When you take a screenshot, the image stays on your computer:

- It's held in memory while you frame it and mark it up.
- **Copy** puts it on your clipboard. **Save** opens your browser's Save
  dialog, so you choose where the file goes.
- On pages where the overlay can't run (the browser's own pages, for example),
  and for whole-page captures, the image is passed to NhakoCapture's editing
  window through your browser's local extension storage. It's deleted as soon
  as that window opens.

Nothing is uploaded anywhere. Once you close the overlay or the editing
window, NhakoCapture doesn't keep a copy.

## Permissions

| Permission | What it's used for |
|---|---|
| `activeTab` | Capturing the tab you're on, only after you ask it to. |
| `scripting` | Showing the capture overlay on that tab, and opening the print preview for *Save as PDF*. |
| `storage` | Handing one capture to the editing window. It's removed straight away. |
| `downloads` | Opening the Save dialog when you save a screenshot. |
| `offscreen` | Copying images to the clipboard on plain `http://` pages. |

## Changes

If this policy ever changes, the new version will be published here with a
new date at the top.

## Contact

Questions? Open an issue at
[github.com/kimzam30/NhakoCapture/issues](https://github.com/kimzam30/NhakoCapture/issues).
