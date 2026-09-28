#!/usr/bin/env python3
"""Generate the NhakoCapture icon set from the SVG masters.

The mark is a butterfly caught in a capture frame: the Nhako family's
butterfly (NhakoSearch, NeraOS) inside the universal "select an area" symbol.
Two masters, because one drawing cannot serve every size:

    docs/brand/logo.svg        48px and up, and everywhere the brand appears
    docs/brand/logo-small.svg  16px and 32px -- heavier frame, bigger
                               butterfly, no tape, spots or antennae, which
                               all turn to grey noise in the toolbar

Each master is rendered once at 1024px by headless Chrome (the SVGs use
gradients and filters that no Python rasteriser on a stock machine handles),
then downsampled with LANCZOS for clean antialiased edges.

    python3 tools/make-icons.py
"""

import os
import shutil
import subprocess
import tempfile
from PIL import Image

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
BRAND = os.path.join(ROOT, "docs", "brand")
ICONS = os.path.join(ROOT, "icons")

SMALL = (16, 32)
LARGE = (48, 128)
MASTER_PX = 1024


def chrome():
    for name in ("google-chrome", "chromium", "chromium-browser", "brave-browser"):
        path = shutil.which(name)
        if path:
            return path
    raise SystemExit("make-icons: needs a Chromium-based browser on PATH")


def render(svg_name, out_png):
    """Rasterise one master at MASTER_PX on a transparent background."""
    svg = os.path.join(BRAND, svg_name)
    with tempfile.TemporaryDirectory() as tmp:
        page = os.path.join(tmp, "page.html")
        with open(page, "w") as f:
            f.write(
                "<html><body style='margin:0;background:transparent'>"
                f"<img src='file://{svg}' width='{MASTER_PX}' height='{MASTER_PX}' "
                "style='display:block'></body></html>"
            )
        subprocess.run(
            [
                chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars",
                "--allow-file-access-from-files",
                "--default-background-color=00000000",
                f"--user-data-dir={os.path.join(tmp, 'profile')}",
                f"--window-size={MASTER_PX},{MASTER_PX}",
                f"--screenshot={out_png}", f"file://{page}",
            ],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    return Image.open(out_png).convert("RGBA")


def save(img, size, path):
    img.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True)
    print(f"wrote {os.path.relpath(path, ROOT)}")


if __name__ == "__main__":
    os.makedirs(ICONS, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        large = render("logo.svg", os.path.join(tmp, "large.png"))
        small = render("logo-small.svg", os.path.join(tmp, "small.png"))

    for s in SMALL:
        save(small, s, os.path.join(ICONS, f"icon{s}.png"))
    for s in LARGE:
        save(large, s, os.path.join(ICONS, f"icon{s}.png"))

    # For the README, the poster and anywhere an <img> cannot take an SVG.
    save(large, 512, os.path.join(BRAND, "logo-512.png"))
