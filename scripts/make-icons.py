"""Generate the app icons.

Committed as a script rather than as binary blobs with no history, so the icons
can be regenerated when the name or the palette changes, and so the next person
can see what they are rather than opening a PNG to find out.

The mark is a gauge arc running through the real CPCB NAQI band colours —
green, yellow, orange, red, maroon — with a needle sitting in the middle of the
scale. It reads as "air quality index" at 48px without a single letter of text,
which matters because a home-screen icon is mostly seen small, and it uses the
same palette the app itself displays, so the icon and the product agree.

Usage:  python3 scripts/make-icons.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"

# Straight from lib/aqi-config.json, so the icon cannot drift from the scale
# the app draws. Good -> Severe.
BANDS = ["#00b050", "#92d050", "#ffff00", "#ff7e00", "#ff0000", "#7e0023"]
INK = (18, 23, 27)          # THEME_COLOR in lib/brand.ts
NEEDLE = (255, 255, 255)

# Render large and downsample: PIL has no antialiasing on arcs, and a 4x
# supersample is the cheapest way to get a clean curve.
SS = 4


def rgb(hex_colour: str) -> tuple[int, int, int]:
    h = hex_colour.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def draw_icon(size: int, *, maskable: bool) -> Image.Image:
    """One icon.

    `maskable` shrinks the mark into the centre 80%, because Android may crop
    a maskable icon to a circle, a squircle or a rounded square depending on
    the launcher. Anything outside that safe zone can be cut off.
    """
    s = size * SS
    img = Image.new("RGBA", (s, s), (*INK, 255))
    d = ImageDraw.Draw(img)

    # Safe zone: a maskable icon keeps the mark well inside the canvas.
    inset = s * (0.26 if maskable else 0.18)
    # The arc covers left, top and right but not the bottom 120 degrees, so its
    # visual weight sits high in a square box. Shifting the box DOWN brings the
    # mark back to the optical centre.
    drop = s * 0.055
    box = (inset, inset + drop, s - inset, s - inset + drop)
    width = int(s * (0.115 if maskable else 0.13))

    # A 240-degree gauge, opening at the bottom, split evenly across the six
    # bands. Drawn clockwise from the lower left.
    start, sweep = 150.0, 240.0
    step = sweep / len(BANDS)
    for i, colour in enumerate(BANDS):
        a0 = start + i * step
        # Half a degree of overlap, or antialiasing leaves hairlines between
        # the segments after downsampling.
        d.arc(box, a0 - 0.5, a0 + step + 0.5, fill=(*rgb(colour), 255), width=width)

    # The needle sits at the middle of the scale rather than pointing at a
    # value: the icon should not claim a reading.
    cx = s / 2
    cy = s / 2 + drop
    angle = math.radians(start + sweep / 2)
    r_outer = (s / 2 - inset) - width * 0.35
    hub = s * 0.058
    # From the hub, NOT from a radius outside it. A gap between needle and hub
    # reads as an exclamation mark -- a warning sign rather than a gauge, which
    # is the wrong thing entirely for an app whose whole argument is not
    # overclaiming.
    d.line(
        [(cx, cy),
         (cx + r_outer * math.cos(angle), cy + r_outer * math.sin(angle))],
        fill=(*NEEDLE, 255), width=int(s * 0.05),
    )
    d.ellipse([cx - hub, cy - hub, cx + hub, cy + hub], fill=(*NEEDLE, 255))

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    PUBLIC.mkdir(exist_ok=True)
    written = []

    for size in (192, 512):
        for maskable in (False, True):
            name = f"icon-{size}{'-maskable' if maskable else ''}.png"
            draw_icon(size, maskable=maskable).save(PUBLIC / name)
            written.append(name)

    # iOS ignores the manifest's icons and uses this one. It also does not
    # round the corners of a transparent PNG gracefully, hence the solid
    # background, and it never applies a mask — so the non-maskable framing.
    draw_icon(180, maskable=False).save(PUBLIC / "apple-touch-icon.png")
    written.append("apple-touch-icon.png")

    # The browser tab. 32px is small enough that the needle is the only thing
    # that survives, which is fine — it still reads as a gauge.
    draw_icon(32, maskable=False).save(PUBLIC / "favicon.png")
    written.append("favicon.png")

    print(json.dumps({"wrote": written, "into": str(PUBLIC.relative_to(ROOT))}, indent=2))


if __name__ == "__main__":
    main()
