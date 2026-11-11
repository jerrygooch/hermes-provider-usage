#!/usr/bin/env python3
"""Prepare a portable, sanitized Provider Usage definition package locally.

Usage:
    python scripts/package-definition.py <definition.json> [--out dist/contributions]

The script validates against the plugin's schema, rejects secret-looking values
and machine-local paths, and writes a canonical definition plus a README and
hashes. It never calls GitHub or any network endpoint. Publishing a catalog PR
stays a manual, reviewed action.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bghp_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b", re.IGNORECASE),
]
LOCAL_PATH_PATTERNS = [
    re.compile(r"[A-Za-z]:[\\/]+Users[\\/]+", re.IGNORECASE),
    re.compile(r"/Users/[^/\s]+/"),
    re.compile(r"/home/[^/\s]+/"),
    re.compile(r"\\\\[^\\\s]+\\"),
]


def load_backend():
    path = Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py"
    module_name = "provider_usage_plugin_api_packager"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def scan(value, patterns, trail="definition"):
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            found.extend(scan(item, patterns, f"{trail}.{key}"))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(scan(item, patterns, f"{trail}[{index}]"))
    elif isinstance(value, str):
        for pattern in patterns:
            if pattern.search(value):
                found.append(trail)
                break
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("definition", help="definition JSON file")
    parser.add_argument("--out", default="dist/contributions", help="output root (default: dist/contributions)")
    args = parser.parse_args()

    source = Path(args.definition)
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        print(f"cannot read {source}: {exc}", file=sys.stderr)
        return 2

    backend = load_backend()
    definition, errors, warnings = backend._validate_definition(raw, source="profile", allow_override=True)
    if not definition:
        print("definition is invalid; nothing was packaged", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1

    dirty = scan(definition, LOCAL_PATH_PATTERNS)
    if dirty:
        print("refusing to package machine-local paths at: " + ", ".join(sorted(set(dirty))), file=sys.stderr)
        return 1
    secrets = scan(definition, SECRET_PATTERNS)
    if secrets:
        print("refusing to package secret-looking values at: " + ", ".join(sorted(set(secrets))), file=sys.stderr)
        return 1

    public = {key: value for key, value in definition.items() if not key.startswith("_")}
    outdir = Path(args.out).resolve() / definition["id"]
    outdir.mkdir(parents=True, exist_ok=True)
    definition_path = outdir / "definition.json"
    canonical = json.dumps(public, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    definition_path.write_text(canonical, encoding="utf-8")
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    credential_refs = [
        backend._credential_label(spec["credential"])
        for spec in public["request"].get("headers", [])
    ]
    windows = public["mapping"].get("windows") or []
    windows_from = public["mapping"].get("windows_from")
    balances = public["mapping"].get("balances") or []
    readme = f"""# {public['name']}

- Definition id: `{public['id']}`
- Version: `{public['version']}`
- Endpoint host: `{backend._definition_endpoint_host(public)}`
- Credential references: {', '.join(f'`{item}`' for item in credential_refs) if credential_refs else 'none (public endpoint)'}
- Windows: {len(windows) + (1 if windows_from else 0)}
- Balances: {len(balances)}
- Source docs: {public.get('docs_url') or 'not provided'}
- Stability: {public.get('stability') or 'experimental'}

This package contains data only. It has no credential values, scripts, local
paths, or account data. To use it, copy `definition.json` into
`$HERMES_HOME/provider-usage/providers/{public['id']}.json`, set the referenced
environment variables if any, and refresh Provider Usage.

Validate before contributing:

```bash
python scripts/validate_definition.py definition.json
```

Open a catalog pull request manually after reviewing this package. The
packager does not publish to GitHub.

SHA-256 of `definition.json`: `{digest}`
"""
    (outdir / "README.md").write_text(readme, encoding="utf-8")
    manifest = {
        "package_version": 1,
        "definition_id": public["id"],
        "definition_version": public["version"],
        "host": backend._definition_endpoint_host(public),
        "credential_refs": credential_refs,
        "sha256": digest,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "warnings": warnings,
    }
    (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"packaged {public['id']} -> {outdir}")
    print(f"sha256 {digest}")
    print("No network or GitHub request was made. Review and open a PR manually.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
