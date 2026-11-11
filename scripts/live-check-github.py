#!/usr/bin/env python3
"""Live-check the bundled GitHub rate-limit definition (no credential needed).

Prints only normalized state and window values; never prints the provider body
or any request headers. Exit code 0 only when the definition fetches and maps.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_backend():
    path = ROOT / "dashboard" / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("provider_usage_plugin_api_live", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["provider_usage_plugin_api_live"] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    backend = load_backend()
    loaded = backend._load_provider_definitions()
    entry = loaded["valid"].get("github-rate-limit")
    if not entry:
        print("github-rate-limit is not in the valid catalog", file=sys.stderr)
        return 1
    row = backend._fetch_declarative_cached(entry["definition"], profile="default")
    windows = (row.get("limits") or [{}])[0].get("windows") or []
    print(f"state={row.get('state')} available={row.get('available')} windows={len(windows)}")
    print(f"host={row.get('provenance', {}).get('endpoint_host')} cache={row.get('provenance', {}).get('cache')}")
    for window in windows:
        print(
            f"  {window.get('label')}: remaining_percent={window.get('remaining_percent')} "
            f"used={window.get('used')} limit={window.get('limit')} reset_at={window.get('reset_at')}"
        )
    if row.get("state") != "ok":
        print(f"reason={row.get('unavailable_reason')}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
