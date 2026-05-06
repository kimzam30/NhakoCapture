//nhakocapture by kimzam


if (!document.getElementById("brave-snap-overlay")) {
  
  const overlay = document.createElement("div");
  overlay.id = "brave-snap-overlay";
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0, 0, 0, 0.6); z-index: 2147483647;
    display: flex; justify-content: center; align-items: flex-start; padding-top: 30px;
    backdrop-filter: blur(3px); font-family: sans-serif;
  `;

  const btnContainer = document.createElement("div");
  btnContainer.style.cssText = "display: flex; gap: 15px;";

  const createBtn = (text, bgColor) => {
    const btn = document.createElement("button");
    btn.innerText = text;
    btn.style.cssText = `
      background: ${bgColor}; color: white; border: none; padding: 10px 18px;
      border-radius: 6px; font-size: 14px; font-weight: bold; cursor: pointer;
      box-shadow: 0 4px 10px rgba(0,0,0,0.3); transition: transform 0.1s;
    `;
    btn.onmouseover = () => btn.style.transform = "scale(1.05)";
    btn.onmouseout = () => btn.style.transform = "scale(1)";
    return btn;
  };

  const captureBtn = createBtn("📸 Capture Visible Page", "#8a2be2");
  const cropBtn = createBtn("✂️ Crop Selection", "#8a2be2");
  const cancelBtn = createBtn("❌ Cancel", "#555555");

  btnContainer.append(captureBtn, cropBtn, cancelBtn);
  overlay.appendChild(btnContainer);

  let isCropping = false;
  let startX, startY;
  let selectionBox = null;

  cropBtn.onclick = () => {
    isCropping = true;
    btnContainer.style.display = "none"; 
    overlay.style.background = "transparent"; 
    overlay.style.backdropFilter = "none"; 
    overlay.style.cursor = "crosshair";
  };

  overlay.onmousedown = (e) => {
    if (!isCropping) return;
    startX = e.clientX;
    startY = e.clientY;

    selectionBox = document.createElement("div");
    selectionBox.style.cssText = `
      position: fixed; border: 2px solid #8a2be2;
      box-shadow: 0 0 0 9999px rgba(0,0,0,0.5); 
      z-index: 2147483648; pointer-events: none;
    `;
    document.body.appendChild(selectionBox);
    updateBox(e);
  };

  overlay.onmousemove = (e) => {
    if (!isCropping || !selectionBox) return;
    updateBox(e);
  };

  const updateBox = (e) => {
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    selectionBox.style.left = x + "px";
    selectionBox.style.top = y + "px";
    selectionBox.style.width = w + "px";
    selectionBox.style.height = h + "px";
  };

  overlay.onmouseup = (e) => {
    if (!isCropping || !selectionBox) return;
    isCropping = false;

    const rect = {
      x: Math.min(startX, e.clientX),
      y: Math.min(startY, e.clientY),
      w: Math.abs(e.clientX - startX),
      h: Math.abs(e.clientY - startY)
    };

    selectionBox.remove();
    overlay.remove();

    if (rect.w > 10 && rect.h > 10) {
      setTimeout(() => {
        chrome.runtime.sendMessage({ 
          action: "take_screenshot", 
          cropRect: rect, 
          // Grab the exact window size for perfect math later
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight
        });
      }, 200); 
    }
  };

  captureBtn.onclick = () => {
    overlay.remove();
    setTimeout(() => {
      chrome.runtime.sendMessage({ 
        action: "take_screenshot",
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight
      });
    }, 200); 
  };

  cancelBtn.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (selectionBox) selectionBox.remove();
      if (overlay) overlay.remove();
    }
  });