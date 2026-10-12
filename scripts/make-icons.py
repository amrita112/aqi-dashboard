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
    """One icon: a rising trend line over the AQI colour bands.

    WHY A TREND LINE. The previous mark was a gauge, which says "a reading" —
    and a reading is the thing this app is least able to give you, because the
    data is days old. A trend says "where this is going", which is what the app
    actually does and what its forecast and trends screens are for.

    The line climbs because that is the honest shape of October in these
    cities, and it is drawn over a strip of the real CPCB band colours, so the
    icon carries the scale the app uses without a single letter of text.

    `maskable` shrinks the mark into the centre, because Android may crop a
    maskable icon to a circle, a squircle or a rounded square depending on the
    launcher, and anything outside that safe zone can be cut off.
    """
    s = size * SS
    img = Image.new("RGBA", (s, s), (*INK, 255))
    d = ImageDraw.Draw(img)

    inset = s * (0.30 if maskable else 0.22)
    left, right = inset, s - inset
    width = right - left

    # The band strip along the bottom: Good through Severe, left to right. Low
    # enough to read as a scale the line sits above rather than a block.
    strip_h = s * 0.085
    strip_top = s - inset - strip_h
    seg = width / len(BANDS)
    for i, colour in enumerate(BANDS):
        d.rectangle(
            (left + i * seg, strip_top, left + (i + 1) * seg, strip_top + strip_h),
            fill=(*rgb(colour), 255),
        )

    # The trend. Fixed points rather than data: an icon is a logo, and one that
    # changed with the forecast would be unrecognisable from one day to the next.
    top = inset + s * 0.01
    # Small gap only: the strip reads as the axis the line is plotted against,
    # and a wide gap made them look like two unrelated marks.
    plot_h = strip_top - top - s * 0.02
    shape = [0.70, 0.86, 0.52, 0.64, 0.30, 0.12]
    pts = [
        (left + (i / (len(shape) - 1)) * width, top + f * plot_h)
        for i, f in enumerate(shape)
    ]

    d.line(pts, fill=NEEDLE, width=int(s * 0.055), joint="curve")

    # A dot on the last point, in the band the line has climbed into, so the
    # mark ends on the colour it is warning about.
    r = s * 0.052
    x, y = pts[-1]
    d.ellipse((x - r, y - r, x + r, y + r), fill=(*rgb(BANDS[3]), 255), outline=NEEDLE,
              width=int(s * 0.016))

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
