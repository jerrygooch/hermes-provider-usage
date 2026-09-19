#!/usr/bin/env python3
"""Crop the raw harness preview shots to their content bounds and install them
as the repository README assets.

Regenerate the raw shots first (Pillow required for this crop step):

    node harness/build.mjs
    node harness/capture.mjs --fixture preview-showcase --width 1400 --clean
    node harness/popover-verify.mjs --fixture preview-showcase
    python harness/export-previews.py
"""
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "harness" / "dist" / "shots"
ASSETS = ROOT / "assets"

PREVIEWS = (
    ("preview-showcase_w1400.png", "provider-usage-page.png", 16),
    ("popover-open_w760.png", "provider-usage-popover.png", 12),
)


def trim(image: Image.Image, pad: int) -> Image.Image:
    width, height = image.size
    corners = [image.getpixel(p) for p in ((1, 1), (width - 2, 1), (1, height - 2), (width - 2, height - 2))]
    background = max(set(corners), key=corners.count)
    diff = ImageChops.difference(image, Image.new("RGB", image.size, background)).convert("L")
    bbox = diff.point(lambda value: 255 if value > 4 else 0).getbbox()
    if bbox is None:
        raise SystemExit("no content found to crop")
    left = max(0, bbox[0] - pad)
    top = max(0, bbox[1] - pad)
    right = min(width, bbox[2] + pad)
    bottom = min(height, bbox[3] + pad)
    return image.crop((left, top, right, bottom))


def main() -> None:
    for source, target, pad in PREVIEWS:
        path = SHOTS / source
        if not path.exists():
            raise SystemExit(f"missing raw shot: {path} — regenerate first")
        image = trim(Image.open(path).convert("RGB"), pad)
        out = ASSETS / target
        image.save(out)
        if Image.open(out).info:
            raise SystemExit(f"metadata leaked into {out}")
        print(f"{target}: {image.size[0]}x{image.size[1]} from {source}")


if __name__ == "__main__":
    main()
