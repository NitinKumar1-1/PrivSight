"""Generates the PrivSight extension icon set (shield + eye) into public/icons/.

Drawn programmatically so the asset is reproducible and unencumbered: no
external artwork, no fonts. Rendered at 1024 px with supersampling, then
downscaled to the sizes Chrome uses for the toolbar, the extensions page and
the web store card.

    python scripts/make-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZES = (16, 32, 48, 128)
CANVAS = 1024
OUT = Path(__file__).resolve().parent.parent / "public" / "icons"

# Palette: deep blue shield (privacy), white eye (vision), amber pupil (agent focus).
SHIELD = (29, 78, 216)
SHIELD_DARK = (30, 58, 138)
EYE = (255, 255, 255)
IRIS = (245, 158, 11)
PUPIL = (17, 24, 39)


def shield_path(size: int, inset: int) -> list[tuple[float, float]]:
    """Shield outline: flat top with rounded shoulders, tapering to a point."""
    w = size - 2 * inset
    x0, y0 = inset, inset
    top = y0 + w * 0.10
    return [
        (x0 + w * 0.50, y0 + w * 0.02),
        (x0 + w * 0.94, top),
        (x0 + w * 0.94, y0 + w * 0.50),
        (x0 + w * 0.80, y0 + w * 0.82),
        (x0 + w * 0.50, y0 + w * 0.99),
        (x0 + w * 0.20, y0 + w * 0.82),
        (x0 + w * 0.06, y0 + w * 0.50),
        (x0 + w * 0.06, top),
    ]


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Shield body with a darker rim for definition at small sizes.
    d.polygon(shield_path(size, int(size * 0.04)), fill=SHIELD_DARK)
    d.polygon(shield_path(size, int(size * 0.09)), fill=SHIELD)

    # Eye: almond shape from two intersecting circles' lens, approximated with an ellipse mask.
    cx, cy = size * 0.50, size * 0.50
    eye_w, eye_h = size * 0.62, size * 0.34
    lens = Image.new("L", (size, size), 0)
    ld = ImageDraw.Draw(lens)
    r = eye_w / 2 * 1.35
    off = r - eye_h / 2
    ld.ellipse((cx - r, cy - off - r, cx + r, cy - off + r), fill=255)
    lens2 = Image.new("L", (size, size), 0)
    ImageDraw.Draw(lens2).ellipse((cx - r, cy + off - r, cx + r, cy + off + r), fill=255)
    lens = Image.fromarray(__import__("numpy").minimum(__import__("numpy").array(lens), __import__("numpy").array(lens2)))
    white = Image.new("RGBA", (size, size), EYE)
    img.paste(white, (0, 0), lens)

    # Iris and pupil, with a small highlight.
    ir = size * 0.135
    d.ellipse((cx - ir, cy - ir, cx + ir, cy + ir), fill=IRIS)
    pr = size * 0.075
    d.ellipse((cx - pr, cy - pr, cx + pr, cy + pr), fill=PUPIL)
    hr = size * 0.028
    d.ellipse((cx - pr * 0.45 - hr, cy - pr * 0.45 - hr, cx - pr * 0.45 + hr, cy - pr * 0.45 + hr), fill=EYE)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master = draw_icon(CANVAS)
    for size in SIZES:
        icon = master.resize((size, size), Image.LANCZOS)
        icon.save(OUT / f"icon-{size}.png", optimize=True)
        print(f"wrote {OUT / f'icon-{size}.png'}")
    master.resize((256, 256), Image.LANCZOS).save(OUT / "icon-256.png", optimize=True)
    print(f"wrote {OUT / 'icon-256.png'}")


if __name__ == "__main__":
    main()
