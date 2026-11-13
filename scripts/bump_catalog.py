#!/usr/bin/env python3
"""Move the catalogue pin for this plugin to the current commit.

The Hermes plugin catalogue pins a full 40-character SHA; branches and tags are
rejected, so every release needs a pin-bump PR against NousResearch/hermes-agent.
This script rewrites the one YAML file so that PR is mechanical.

Usage:
    python scripts/bump_catalog.py --catalog-dir C:/path/to/hermes-agent/plugin-catalog
    python scripts/bump_catalog.py --catalog-dir ... --write

Without --write it prints the change and writes nothing.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ENTRY = "jg-provider-usage.yaml"
REPO = "https://github.com/jerrygooch/hermes-provider-usage"
SHA_RE = re.compile(r"\b[0-9a-f]{40}\b")


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog-dir", required=True, type=Path,
                        help="the hermes-agent plugin-catalog directory")
    parser.add_argument("--version", default="", help="defaults to package.json version")
    parser.add_argument("--sha", default="", help="defaults to HEAD of this checkout")
    parser.add_argument("--write", action="store_true", help="apply the change")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    version = args.version or json.loads((repo_root / "package.json").read_text(encoding="utf-8"))["version"]
    sha = args.sha or _git("rev-parse", "HEAD")
    if not SHA_RE.fullmatch(sha):
        print(f"refusing: {sha!r} is not a full 40-character commit SHA", file=sys.stderr)
        return 2

    entry = args.catalog_dir / ENTRY
    if not entry.is_file():
        print(f"refusing: no catalogue entry at {entry}", file=sys.stderr)
        return 2

    text = entry.read_text(encoding="utf-8")
    old_shas = sorted({m.group(0) for m in SHA_RE.finditer(text)})
    if len(old_shas) > 1:
        print(f"refusing: entry pins more than one commit: {old_shas}", file=sys.stderr)
        return 2
    old_sha = old_shas[0] if old_shas else ""
    old_version = re.search(r'^version:\s*"([^"]+)"', text, re.MULTILINE)
    old_version = old_version.group(1) if old_version else ""

    if old_sha == sha and old_version == version:
        print(f"already pinned to {sha[:8]} ({version}); nothing to do")
        return 0

    if old_sha:
        text = text.replace(old_sha, sha)
    text = re.sub(r'^version:\s*"[^"]+"', f'version: "{version}"', text, count=1, flags=re.MULTILINE)

    print(f"catalogue entry: {entry}")
    print(f"  sha:     {old_sha[:8] or '(none)'} -> {sha[:8]}")
    print(f"  version: {old_version or '(none)'} -> {version}")
    print(f"  compare: {REPO}/compare/{old_sha}...{sha}")

    if not args.write:
        print("dry run; pass --write to apply")
        return 0

    entry.write_text(text, encoding="utf-8", newline="")
    print("written")
    print("next: review the diff, run `hermes plugins validate <plugin dir>`, then open the pin-bump PR")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
