chrome.action.onClicked.addListener((tab) => {
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"]
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "take_screenshot") {
    
    // Using .then() ensures Manifest V3 handles the async correctly
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }).then(dataUrl => {
      
      chrome.storage.local.set({ 
        capturedImage: dataUrl,
        cropRect: message.cropRect || null,
        innerWidth: message.innerWidth || 1,
        innerHeight: message.innerHeight || 1
      }).then(() => {
        chrome.windows.create({
          url: "editor.html",
          type: "popup",
          width: 1000,
          height: 700,
          focused: true
        });
      });

    });
  }
});