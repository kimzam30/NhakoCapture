//nhakocapture by kimzam

document.addEventListener("DOMContentLoaded", async () => {
  const canvas = document.getElementById("screenshotCanvas");
  const ctx = canvas.getContext("2d");
  
  let originalImg = new Image();
  let isDragging = false;
  let startX = 0, startY = 0, currentX = 0, currentY = 0;
  let selectionExists = false;

  const result = await chrome.storage.local.get(["capturedImage", "cropRect", "innerWidth", "innerHeight"]);
  
  if (result.capturedImage) {
    chrome.storage.local.remove(["capturedImage", "cropRect", "innerWidth", "innerHeight"]);
    
    originalImg.onload = () => {
      // 1. Check if there is an instant crop request
      if (result.cropRect && result.cropRect.w > 0) {
        
        const scaleX = originalImg.width / result.innerWidth;
        const scaleY = originalImg.height / result.innerHeight;

        const cx = result.cropRect.x * scaleX;
        const cy = result.cropRect.y * scaleY;
        const cw = result.cropRect.w * scaleX;
        const ch = result.cropRect.h * scaleY;

        canvas.width = cw;
        canvas.height = ch;
        ctx.drawImage(originalImg, cx, cy, cw, ch, 0, 0, cw, ch);
        
        // THE BUG FIX: Clear the cropRect so it doesn't loop and destroy the image!
        result.cropRect = null; 
        
        // Update the original image so you can crop it again in the editor
        originalImg.src = canvas.toDataURL();

      } else {
        // 2. Standard load (Full page or secondary loops)
        canvas.width = originalImg.width;
        canvas.height = originalImg.height;
        ctx.drawImage(originalImg, 0, 0);
      }
    };
    originalImg.src = result.capturedImage;
  }

  // --- MOUSE EVENTS FOR EDITOR CROPPING ---
  canvas.addEventListener("mousedown", (e) => {
    isDragging = true;
    selectionExists = false;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    startX = (e.clientX - rect.left) * scaleX;
    startY = (e.clientY - rect.top) * scaleY;
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    currentX = (e.clientX - rect.left) * scaleX;
    currentY = (e.clientY - rect.top) * scaleY;

    const x = Math.min(startX, currentX);
    const y = Math.min(startY, currentY);
    const w = Math.abs(currentX - startX);
    const h = Math.abs(currentY - startY);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(originalImg, 0, 0);

    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (w > 0 && h > 0) {
      ctx.drawImage(originalImg, x, y, w, h, x, y, w, h);
    }

    ctx.strokeStyle = "#8a2be2";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  });

  canvas.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      selectionExists = true;
    }
  });

  // --- BUTTON LOGIC ---
  document.getElementById("cropBtn").addEventListener("click", () => {
    if (!selectionExists) return;

    const x = Math.min(startX, currentX);
    const y = Math.min(startY, currentY);
    const w = Math.abs(currentX - startX);
    const h = Math.abs(currentY - startY);

    if (w === 0 || h === 0) return;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext("2d");
    tempCtx.drawImage(originalImg, x, y, w, h, 0, 0, w, h);

    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(tempCanvas, 0, 0);
    originalImg.src = canvas.toDataURL();
    selectionExists = false;
  });


  const copyToClipboard = () => {
    canvas.toBlob((blob) => {
      if (!blob) return alert("Error: Canvas is empty!"); 
      
      navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob })
      ]).then(() => {
        const btn = document.getElementById("copyBtn");
        btn.innerText = "Copied!";
        // Close the window after 600ms so the user sees the "Copied!" text briefly
        setTimeout(() => window.close(), 600);
      }).catch(err => console.error("Clipboard error:", err));
    });
  };

  document.getElementById("copyBtn").addEventListener("click", copyToClipboard);

  // Keyboard Shortcuts: Ctrl+C to Copy, Escape to close window
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copyToClipboard();
    }
    if (e.key === "Escape") {
      window.close(); // Close the editor instantly
    }
  });

  document.getElementById("saveBtn").addEventListener("click", () => {
    if (canvas.width === 0 || canvas.height === 0) return alert("Nothing to save!");
    
    const link = document.createElement("a");
    link.download = `Screenshot_${new Date().getTime()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    
    // Close the editor instantly after saving
    setTimeout(() => window.close(), 100);
  });
  });