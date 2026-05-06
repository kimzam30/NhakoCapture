//nhakocapture by kimzam


chrome.action.onClicked.addListener(async (tab) => {
  try {
    // Try to inject the overlay for the live-crop tool
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (error) {
    // FALLBACK: If we are on a restricted page (like settings), skip the overlay and just snap the picture!
    console.log("Restricted page detected, falling back to instant capture.");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    
    await chrome.storage.local.set({ 
      capturedImage: dataUrl,
      cropRect: null,
      innerWidth: 1,
      innerHeight: 1
    });
    
    chrome.windows.create({
      url: "editor.html", type: "popup", width: 1000, height: 700, focused: true
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "take_screenshot") {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }).then(dataUrl => {
      chrome.storage.local.set({ 
        capturedImage: dataUrl,
        cropRect: message.cropRect || null,
        innerWidth: message.innerWidth || 1,
        innerHeight: message.innerHeight || 1
      }).then(() => {
        chrome.windows.create({
          url: "editor.html", type: "popup", width: 1000, height: 700, focused: true
        });
      });
    });
  }
});