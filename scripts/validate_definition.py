#!/usr/bin/env python3
"""Validate a Provider Usage declarative definition without network access.

Usage:
    python scripts/validate_definition.py dashboard/definitions/catalog/*.json
    python scripts/validate_definition.py ~/.hermes/provider-usage/providers/my-api.json --json

Exit codes: 0 = valid, 1 = invalid, 2 = unreadable file.
The validator imports the plugin backend exactly as the dashboard loader does
(module registered before exec), so it tests the same schema code the app uses.
"""

from __future__ import annotations

import argparse
import glob
import importlib.util
import json
import sys
from pathlib import Path


def load_backend():
    path = Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py"
    module_name = "provider_usage_plugin_api_validator"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", help="definition JSON file(s), a directory, or a glob")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    parser.add_argument("--allow-override", action="store_true", default=True, help=argparse.SUPPRESS)
    args = parser.parse_args()

    backend = load_backend()
    results = []
    failed = False
    expanded: list[Path] = []
    for filename in args.files:
        candidate = Path(filename)
        if candidate.is_dir():
            expanded.extend(sorted(candidate.glob("*.json")))
        elif any(char in filename for char in "*?["):
            expanded.extend(Path(item) for item in sorted(glob.glob(filename)))
        else:
            expanded.append(candidate)
    if not expanded:
        print("no definition files found", file=sys.stderr)
        return 2
    for path in expanded:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            print(f"{path}: cannot read JSON: {exc}", file=sys.stderr)
            failed = True
            results.append({"file": str(path), "ok": False, "errors": [f"file: {exc}"]})
            continue
        definition, errors, warnings = backend._validate_definition(
            raw,
            source="profile",
            allow_override=True,
        )
        result = {
            "file": path.name,
            "ok": bool(definition),
            "errors": errors,
            "warnings": warnings,
            "id": (definition or {}).get("id") or raw.get("id") if isinstance(raw, dict) else None,
            "name": (definition or {}).get("name") or raw.get("name") if isinstance(raw, dict) else None,
            "version": (definition or {}).get("version"),
            "host": backend._definition_endpoint_host(definition) if definition else None,
            "credential_refs": [
                backend._credential_label(spec["credential"])
                for spec in (definition or {}).get("request", {}).get("headers", [])
            ],
        }
        results.append(result)
        failed = failed or not result["ok"]

    if args.json:
        print(json.dumps({"results": results}, indent=2, ensure_ascii=False))
    else:
        for result in results:
            label = result.get("name") or result.get("id") or result.get("file")
            if result["ok"]:
                print(f"VALID   {label} ({result.get('id')} v{result.get('version')}) -> {result.get('host')}")
                for warning in result.get("warnings") or []:
                    print(f"        warning: {warning}")
            else:
                print(f"INVALID {label}")
                for error in result.get("errors") or []:
                    print(f"        {error}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
