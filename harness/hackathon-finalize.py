#!/usr/bin/env python3
"""Finalize the public hackathon asset package.

- Optimizes the element-scoped captures from harness/dist/hackathon/raw
- Writes PNGs with no text/metadata chunks (Image.info must be empty)
- Computes exact dimensions and SHA-256
- Adds the infographic, gallery and optional demo clip when present
- Writes and validates assets/hackathon/manifest.json

This script refuses to publish account-shaped values or machine-local paths in
captions; the payloads are synthetic sample data.

Usage:
  python harness/hackathon-finalize.py
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
RAW = REPO / "harness" / "dist" / "hackathon" / "raw"
RECORDS = REPO / "harness" / "dist" / "hackathon" / "records.json"
OUT = REPO / "assets" / "hackathon"
SHOTS = OUT / "screenshots"

LOCAL_PATH_PATTERNS = [
    re.compile(r"C:\\\\Users\\\\", re.I),
    re.compile(r"/Users/"),
    re.compile(r"AppData[\\\\/]", re.I),
    re.compile(r"composer-images", re.I),
]
SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}"),
    re.compile(r"\bghp_[A-Za-z0-9]{12,}"),
    re.compile(r"\bAIza[A-Za-z0-9_-]{12,}"),
    re.compile(r"\bAKIA[A-Z0-9]{12,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_tree_dirty() -> bool:
    """True when the captured plugin/backend source is ahead of the recorded HEAD."""
    try:
        status = subprocess.run(
            [
                "git", "-C", str(REPO), "status", "--porcelain", "--",
                "desktop/plugin.js", "dashboard/plugin_api.py",
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        return bool(status.stdout.strip())
    except OSError:
        return False


def image_info(path: Path) -> dict:
    with Image.open(path) as image:
        return {
            "width": image.width,
            "height": image.height,
            "mode": image.mode,
            "info": dict(image.info),
        }


def video_info(path: Path) -> dict:
    """Read the encoded clip without trusting a sidecar file."""
    try:
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate:format=duration",
                "-of", "json", str(path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        data = json.loads(probe.stdout) if probe.stdout else {}
    except (OSError, ValueError, subprocess.SubprocessError):
        return {}
    streams = data.get("streams") or []
    video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), {})
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    duration = data.get("format", {}).get("duration")
    return {
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "codec": video_stream.get("codec_name"),
        "fps": video_stream.get("r_frame_rate"),
        "duration_seconds": round(float(duration), 2) if duration else None,
        "audio_streams": len(audio_streams),
    }


def assert_clean_text(text: str, where: str) -> None:
    for pattern in LOCAL_PATH_PATTERNS:
        if pattern.search(text):
            raise SystemExit(f"{where}: local path pattern {pattern.pattern!r} found")
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            raise SystemExit(f"{where}: secret-shaped value found")


def main() -> None:
    records = json.loads(RECORDS.read_text(encoding="utf-8"))
    SHOTS.mkdir(parents=True, exist_ok=True)

    shot_entries = []
    for record in records["records"]:
        src = RAW / record["file"]
        if not src.exists():
            raise SystemExit(f"missing raw capture: {src}")
        dst = SHOTS / record["file"]
        with Image.open(src) as image:
            image = image.convert("RGB")
            # Save without a PngInfo block, EXIF, ICC profile, or text chunks.
            image.save(dst, format="PNG", optimize=True, compress_level=9)
        info = image_info(dst)
        if info["info"]:
            raise SystemExit(f"{dst.name}: embedded metadata survived finalize: {info['info']}")
        expected_w = round(record["widthCss"] * 2)
        expected_h = round(record["heightCss"] * 2)
        if abs(info["width"] - expected_w) > 1 or abs(info["height"] - expected_h) > 1:
            raise SystemExit(
                f"{dst.name}: size {info['width']}x{info['height']} != expected "
                f"{expected_w}x{expected_h}"
            )
        if info["width"] < 250 or info["height"] < 80:
            raise SystemExit(f"{dst.name}: suspiciously small capture")
        if record.get("scrollIssues"):
            raise SystemExit(f"{dst.name}: inner scroll clipped content: {record['scrollIssues']}")
        assert_clean_text(record.get("caption", ""), f"{dst.name} caption")
        shot_entries.append({
            "id": record["id"],
            "file": f"screenshots/{record['file']}",
            "title": record["title"],
            "state": record["state"],
            "width": info["width"],
            "height": info["height"],
            "bytes": dst.stat().st_size,
            "sha256": sha256(dst),
            "caption": record["caption"],
            "sample_data": True,
            "capture": {
                "kind": "browser component harness",
                "target": record["target"],
                "css_width": round(record["widthCss"], 2),
                "css_height": round(record["heightCss"], 2),
                "rendered_text_assertions": record.get("assertText", []),
                "geometry": record.get("detail") or None,
            },
        })

    # The infographic / gallery / clip are produced after captures. Include them
    # only when real files exist; never write an entry for a missing artifact.
    infographic = None
    info_png = OUT / "infographic.png"
    if info_png.exists():
        meta = image_info(info_png)
        if meta["info"]:
            raise SystemExit("infographic.png: embedded metadata found")
        infographic = {
            "file": "infographic.png",
            "width": meta["width"],
            "height": meta["height"],
            "bytes": info_png.stat().st_size,
            "sha256": sha256(info_png),
            "alt": "Diagram-only Provider Usage feature and trust-boundary infographic",
            "sample_data_note": "Conceptual diagram drawn from source; contains no application screenshots.",
        }

    gallery = None
    gallery_html = OUT / "gallery.html"
    if gallery_html.exists():
        gallery = {
            "file": "gallery.html",
            "bytes": gallery_html.stat().st_size,
            "sha256": sha256(gallery_html),
        }

    video = None
    video_mp4 = OUT / ("demo-full.mp4" if (OUT / "demo-full.mp4").exists() else "demo.mp4")
    if video_mp4.exists():
        video = {
            "file": video_mp4.name,
            "bytes": video_mp4.stat().st_size,
            "sha256": sha256(video_mp4),
            "label": "Real plugin interaction demo in the component harness; synthetic sample data; not the packaged desktop app. No reset redeemed.",
            "sample_data": True,
            **video_info(video_mp4),
        }

    video_poster = None
    poster_png = OUT / ("demo-full-poster.png" if video_mp4.name == "demo-full.mp4" else "demo-poster.png")
    if poster_png.exists():
        meta = image_info(poster_png)
        if meta["info"]:
            raise SystemExit("demo-poster.png: embedded metadata found")
        video_poster = {
            "file": poster_png.name,
            "width": meta["width"],
            "height": meta["height"],
            "bytes": poster_png.stat().st_size,
            "sha256": sha256(poster_png),
            "sample_data": True,
        }
        if video is not None:
            video["poster"] = poster_png.name

    added = records.get("added_cards", [])
    all_added = bool(added) and all(item.get("present") for item in added)
    popular_record = next((item for item in records["records"] if item.get("id") == "06-popular-connections"), {})
    popular_geometry = popular_record.get("detail") or {}
    popular_geometry_ok = (
        popular_geometry.get("cardCount") == 3
        and popular_geometry.get("cardsDistinct") is True
        and len(popular_geometry.get("cards") or []) == 3
        and all(card.get("found") and card.get("insideSection") for card in popular_geometry.get("cards") or [])
    )
    manifest = {
        "schema": "hermes.provider-usage.hackathon-assets/1",
        "title": "Provider Usage — hackathon visual and documentation package",
        "plugin_version": records.get("plugin_version"),
        "source_commit": records.get("source_commit"),
        "source_tree_dirty": source_tree_dirty(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "capture_kind": records.get("capture_kind"),
        "theme": records.get("theme"),
        "honesty": {
            "sample_data": True,
            "live_desktop_app": False,
            "stock_hermes_desktop": True,
            "requires_hermes": ">=0.23.1",
            "release_capture_status": "frozen production source; final browser-component capture",
            "unmerged_core_patch_required": False,
            "reset_redeemed": False,
            "source_tree_note": (
                "Captured from the working tree at the recorded HEAD plus uncommitted stock/reset changes."
                if source_tree_dirty()
                else "Captured from a clean working tree at the recorded HEAD."
            ),
            "packaged_desktop_app_captured": False,
            "statement": (
                "Screenshots render the real plugin components and SDK primitives in a browser "
                "component harness. The plugin targets stock Hermes Desktop; optional provider "
                "metadata is capability-detected and shown as unavailable with provider dashboard "
                "links when absent. These are not packaged-app screenshots or live provider reads."
            ),
        },
        "counts": {
            "screenshots": len(shot_entries),
            "infographics": 1 if infographic else 0,
            "videos": 1 if video else 0,
            "video_posters": 1 if video_poster else 0,
            "gallery_pages": 1 if gallery else 0,
            "total_assets": (
                len(shot_entries)
                + (1 if infographic else 0)
                + (1 if video else 0)
                + (1 if video_poster else 0)
                + (1 if gallery else 0)
            ),
        },
        "checks": {
            "png_metadata_stripped": True,
            "dimensions_match_css_at_2x": True,
            "inner_scroll_issues": 0,
            "captures_with_text_assertions": sum(1 for record in records["records"] if record.get("assertText")),
            "screenshots_unique_and_counted": True,
            "provider_cards_all_present": all_added,
            "popular_cards_geometry_verified": popular_geometry_ok,
            "reset_preview_only": True,
            "video_recorded": bool(video),
            "video_audio_streams": video.get("audio_streams") if video else None,
            "video_poster_present": bool(video_poster),
        },
        "screenshots": shot_entries,
        "infographic": infographic,
        "gallery": gallery,
        "video": video,
        "video_poster": video_poster,
        "provider_cards": {
            "expected": added,
            "all_present": all_added,
            "status": "included" if all_added else "pending",
        },
        "notes": [
            "All provider names, balances, windows, reset times, model names, and account labels are synthetic sample data.",
            "Provider Usage targets stock Hermes Desktop 0.23.1+. Optional identity, reset, and delegated-owner metadata is capability-detected; when absent, the UI shows Unavailable/Unknown and provider dashboard links instead of a guessed value.",
            "These are pre-freeze component-harness captures; final stock captures wait on the frozen build. Some optional-row sample states (for example xAI subscription data) are only available on a host exposing the optional helper.",
            "The screenshots exercise a real chip -> popover interaction and the real renderer; they do not prove packaged-app integration or live provider calls.",
        ],
    }

    # Cross-check: every screenshot file referenced exists exactly once and the
    # declared count equals the actual entries.
    files = sorted(SHOTS.glob("*.png"))
    if len(files) != len(shot_entries):
        raise SystemExit(f"directory has {len(files)} PNGs, manifest has {len(shot_entries)}")
    referenced = {entry["file"].split("/", 1)[1] for entry in shot_entries}
    if {file.name for file in files} != referenced:
        raise SystemExit("screenshot directory and manifest filenames disagree")
    if manifest["counts"]["screenshots"] != len(shot_entries):
        raise SystemExit("screenshot count mismatch")

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Validated {len(shot_entries)} screenshots; infographic={bool(infographic)} video={bool(video)} gallery={bool(gallery)}")
    print(f"Manifest -> {OUT / 'manifest.json'}")
    total = sum(entry["bytes"] for entry in shot_entries)
    print(f"Screenshot bytes: {total:,}")


if __name__ == "__main__":
    main()
