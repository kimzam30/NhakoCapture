# Nhako Capture

A Chromium screenshot extension that brings Opera's native capture workflow to Brave, Chrome, and Edge — floating editor, live cropping, straight to clipboard, without hijacking a new tab.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![JavaScript](https://img.shields.io/badge/Vanilla_JS-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![No dependencies](https://img.shields.io/badge/dependencies-none-success?style=flat-square)

---

## Why

Most screenshot extensions break your flow: they force open a new tab, load a heavy drawing library, and bury "copy to clipboard" behind three clicks. Nhako Capture uses Manifest V3 APIs to spawn a small floating editor window beside your work, so the page you were reading never goes away.

---

## Features

- **Floating editor** — a dedicated popup window rather than a new tab, so your context survives.
- **Live transparent cropping** — a crosshair overlay on the live page with a dimmed surround; drag to select exactly what you want.
- **Instant viewport capture** — snap everything visible in one click.
- **Keyboard-first** — `Ctrl`/`Cmd + C` copies the image and closes the editor; `Esc` cancels a crop or dismisses the window.
- **Re-crop in the editor** — drag inside the editor to trim a second time before saving.
- **Local and private** — no telemetry, no servers, no drawing libraries. Everything runs on HTML5 Canvas in your browser.
- **Graceful on restricted pages** — falls back to instant capture on `chrome://` and extension-store pages instead of failing.

---

## Install (developer mode)

Not on the Web Store — load it unpacked:

1. Clone or download this repository.
2. Open your browser's extensions page:
   - Brave — `brave://extensions`
   - Chrome — `chrome://extensions`
   - Edge — `edge://extensions`
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the **`scripts/` folder** inside this repository — not the repository root. `manifest.json` lives in `scripts/`, and Chromium requires the manifest to sit at the root of the folder you select.
6. Pin the extension from the puzzle-piece menu for one-click access.

---

## Usage

1. Click the **Nhako Capture** toolbar icon. An overlay appears with two options:
   - **Capture Visible Page** — snaps the viewport and opens the editor.
   - **Crop Selection** — turns the cursor into a crosshair; drag to select a region.
2. In the editor window:
   - **Copy to Clipboard** (or `Ctrl+C`) — copies the PNG and closes the editor.
   - **Save Image** — downloads the PNG and closes the editor.
   - Drag inside the image to crop again before doing either.

---

## How it works

| Piece | File | Role |
|---|---|---|
| Service worker | `scripts/background.js` | Handles the toolbar action, captures the tab, opens the editor window |
| Content script | `scripts/content.js` | Injects the overlay and the crosshair crop UI into the live page |
| Editor | `scripts/editor.html`, `scripts/editor.js` | Canvas-based crop, clipboard write, and PNG download |
| Manifest | `scripts/manifest.json` | Manifest V3 declaration and permissions |

Built on `chrome.tabs.captureVisibleTab`, `chrome.scripting.executeScript`, `chrome.windows.create`, and the `navigator.clipboard` API for binary blob writes.

---

## Roadmap

- [x] Visible-viewport capture
- [x] Live selection crop
- [ ] Full-page (scrolling) screenshot
- [ ] Annotations — arrow, rectangle highlight, blur
- [ ] Zoom in the editor
- [ ] Extension icon artwork

---

Built by **kimzam** to restore the Opera capture feel on Brave.
