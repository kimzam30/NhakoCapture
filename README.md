📸 Nhako Capture
================

**By kimzam**

A lightweight, high-performance Chromium browser extension that brings the beloved, native Opera screenshot workflow to Brave and other Chromium browsers.

Tired of screenshot extensions that hijack your workflow by forcing open annoying new tabs? **Nhako Capture** leverages modern Manifest V3 APIs to spawn a native, floating UI over your active tabs, providing lightning-fast screen captures, transparent live-cropping, and seamless clipboard integration without ever leaving your current context.

### ✨ Key Features

*   **🪟 True Floating Editor:** Bypasses the standard "new tab" sandbox restriction. Opens a clean, dedicated popup window that floats beside your work.
    
*   **✂️ Live Transparent Cropping:** Click "Crop Selection" to trigger a crosshair overlay on the live website. Drag to perfectly cut out exactly what you need, aided by a cinematic dark shadow overlay.
    
*   **📸 Instant Visible Capture:** Snap the entire visible viewport with a single click.
    
*   **⚡ Native Keyboard Shortcuts:**
    
    *   Mash Ctrl + C (or Cmd + C) in the editor to instantly copy the image to your clipboard.
        
    *   Hit Esc to instantly cancel a live crop or close the editor window.
        
*   **🛡️ Privacy First & Lean:** Zero telemetry, zero external servers, and no bloated drawing libraries. It runs entirely locally on standard HTML5 Canvas.
    
*   **⚙️ Smart Fallbacks:** Built-in safeguards prevent crashes on restricted browser pages (like settings or extension stores) by intelligently falling back to instant-capture mode.
    

### 🚀 Installation (Developer Mode)

Since this extension is highly optimized for power-user workflows, it can be loaded directly into your browser via Developer Mode:

1.  **Clone or Download** this repository to your local machine.
    
2.  Open your Chromium-based browser (Brave, Chrome, Edge) and navigate to the extensions page:
    
    *   Brave: brave://extensions
        
    *   Chrome: chrome://extensions
        
3.  Toggle on **Developer mode** in the top right corner.
    
4.  Click the **Load unpacked** button in the top left.
    
5.  Select the NhakoCapture folder on your computer.
    
6.  _Tip: Click the puzzle piece icon in your browser toolbar and "Pin" Nhako Capture for quick access!_
    

### 💻 How to Use

1.  Click the **Nhako Capture** icon in your toolbar.
    
2.  A sleek, blurred overlay will appear on the current page with two primary options:
    
    *   **Capture Visible Page:** Instantly snaps the screen and opens the Editor.
        
    *   **Crop Selection:** Turns your cursor into a crosshair. Click and drag to perfectly select a specific element on the page.
        
3.  The **Editor Window** will pop up instantly.
    
    *   Click **Copy to Clipboard** (or press Ctrl+C) to copy the image and auto-close the window.
        
    *   Click **Save Image** to download the PNG directly to your PC and auto-close the window.
        
    *   _Need to adjust?_ You can click and drag inside the Editor to crop the image a second time!
        

### 🛠️ Architecture & Tech Stack

*   **Framework:** Chrome Extensions API (Manifest V3)
    
*   **Languages:** Vanilla JavaScript (ES6+), HTML5, CSS3
    
*   **Core APIs Utilized:**
    
    *   chrome.tabs.captureVisibleTab
        
    *   chrome.scripting.executeScript (For dynamic content injection)
        
    *   chrome.windows.create (For the standalone UI popup)
        
    *   Navigator.clipboard API (For binary Blob copy/pasting)
        

### 📝 License & Credits

Created and maintained by **kimzam**.Built as a passion project to optimize personal workflows and restore the "Opera Feel" to the Brave Browser ecosystem.