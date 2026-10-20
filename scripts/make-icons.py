"""Generate the app icons from Amrita's logo.

The source is design/app-icon.png: a square-ish PNG with a solid background,
made in Google Slides (20 Oct 2026). Every icon the app ships is cut from it
here, so a new logo means replacing that one file and rerunning this script.
(The placeholder this replaced drew a trend line over the CPCB band colours
in code; it is in git history if ever wanted.)

512px is enough. The largest icon the app uses is 512 x 512, and the logo is
flat shapes and solid colours, which scale down cleanly.

Usage:  python3 scripts/make-icons.py
Then bump VERSION in public/sw.js, or phones keep the old cached icons.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
SOURCE = ROOT / "design" / "app-icon.png"

# How much of a maskable icon the logo may fill. Android may crop a maskable
# icon to a circle, squircle or rounded square; only the central circle of
# 80% of the width is guaranteed to survive, and the top of the cloud sits
# outside it at full size.
MASKABLE_SCALE = 0.80


def load_square() -> Image.Image:
    """The logo, padded to an exact square with its own background colour.

    Slides exported 512 x 511, and a one-pixel-short icon is enough for some
    launchers to stretch it. Padding with the corner colour is invisible.
    """
    logo = Image.open(SOURCE).convert("RGB")
    side = max(logo.size)
    background = logo.getpixel((0, 0))
    square = Image.new("RGB", (side, side), background)
    square.paste(logo, ((side - logo.width) // 2, (side - logo.height) // 2))
    return square


def icon(square: Image.Image, size: int, *, maskable: bool) -> Image.Image:
    """One icon at `size`, shrunk into the safe zone when `maskable`."""
    if not maskable:
        return square.resize((size, size), Image.LANCZOS)
    inner = round(size * MASKABLE_SCALE)
    canvas = Image.new("RGB", (size, size), square.getpixel((0, 0)))
    offset = (size - inner) // 2
    canvas.paste(square.resize((inner, inner), Image.LANCZOS), (offset, offset))
    return canvas


def main() -> None:
    PUBLIC.mkdir(exist_ok=True)
    square = load_square()
    written = []

    for size in (192, 512):
        for maskable in (False, True):
            name = f"icon-{size}{'-maskable' if maskable else ''}.png"
            icon(square, size, maskable=maskable).save(PUBLIC / name)
            written.append(name)

    # iOS ignores the manifest's icons and uses this one. It rounds the
    # corners itself and never crops further, so the full-size framing.
    icon(square, 180, maskable=False).save(PUBLIC / "apple-touch-icon.png")
    written.append("apple-touch-icon.png")

    # The browser tab.
    icon(square, 32, maskable=False).save(PUBLIC / "favicon.png")
    written.append("favicon.png")

    print(json.dumps({"from": str(SOURCE.relative_to(ROOT)), "wrote": written}, indent=2))


if __name__ == "__main__":
    main()
