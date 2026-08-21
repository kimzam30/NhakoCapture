## Complete Features
- [ ] Full Page Screenshot
- [x] Selection Crop
- [x] Visible Screen
- [ ] Zoom In/Out
- [ ] add logo to extension

### For Full Page Screenshot
**Scroll Stitch strategy**
- [ ] Content Script - Determines total page height, hides sticky elements, disables scrollbars, and manages the ```windows.scrollTo``` loop.
- [ ] Background Script - Receives ready signal from context script, calls ```captureVisibleTab```, and appends the image data to an array.
- [ ] Offscreen document - Manifest V3, A hidden document used to create a giant ```<canvas>``` that stitches all the frames into one massive PNG

## Bug Fixes
- [ ] Save Button after ss, no popup for destination