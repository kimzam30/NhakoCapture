#!/usr/bin/env python3
"""Generate the NhakoCapture icon set.

The mark is a four-corner crop frame: the universal "select an area" symbol,
and the thing this extension actually does. Four corners rather than two
because symmetry survives downsampling — an asymmetric mark goes lopsided at
16px, where a literal camera or aperture turns to mush entirely.

Stroke weight and arm length are tuned for the 16px toolbar icon specifically;
the larger sizes are forgiving, 16px is not.

Rendered at 8x and downsampled with LANCZOS for clean antialiased edges.

    python3 tools/make-icons.py
"""

import os
from PIL import Image, ImageDraw

SIZES = (16, 32, 48, 128)
SS = 8  # supersample factor

ACCENT = (138, 43, 226)        # #8a2be2 — Nhako purple
ACCENT_LIGHT = (157, 78, 221)  # #9d4edd
WHITE = (255, 255, 255, 255)

INSET = 0.22   # corner distance from tile edge
ARM = 0.24     # bracket arm length
STROKE = 0.095 # bracket stroke weight


def rounded_tile(size):
    """Purple rounded square with a soft vertical gradient."""
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        grad.putpixel((0, y), tuple(
            round(ACCENT_LIGHT[i] + (ACCENT[i] - ACCENT_LIGHT[i]) * t)
            for i in range(3)
        ))
    tile = grad.resize((size, size), Image.NEAREST).convert("RGBA")

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=round(size * 0.22), fill=255
    )
    tile.putalpha(mask)
    return tile


def draw_frame(img, size):
    d = ImageDraw.Draw(img)
    w = max(round(size * STROKE), 1)
    arm = size * ARM
    lo, hi = size * INSET, size - size * INSET
    j = w / 2  # extend past the join so corners are square, not notched

    for x, xs in ((lo, 1), (hi, -1)):
        for y, ys in ((lo, 1), (hi, -1)):
            d.line((x - j * xs, y, x + arm * xs, y), fill=WHITE, width=w)
            d.line((x, y - j * ys, x, y + arm * ys), fill=WHITE, width=w)


def build(size):
    big = size * SS
    img = rounded_tile(big)
    draw_frame(img, big)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "icons")
    os.makedirs(out, exist_ok=True)
    for s in SIZES:
        build(s).save(os.path.join(out, f"icon{s}.png"), "PNG", optimize=True)
        print(f"wrote icons/icon{s}.png")
