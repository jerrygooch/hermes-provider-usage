#!/usr/bin/env python3
"""Explicitly approve one local Provider Usage definition for this Hermes home.

Usage:
    python scripts/approve_definition.py ~/.hermes/provider-usage/providers/my-api.json
    python scripts/approve_definition.py --revoke my-api

The command never reads a credential, never calls the network, and never
approves anything without an interactive confirmation that shows the
destination and credential references. Approval is bound to the exact canonical
definition content (SHA-256), endpoint, and structured credential references;
editing behavior-bearing content revokes it.

This is a local-user trust boundary, not a sandbox: code running as the same
user can edit the definition and the approval manifest. It exists so a
definition that arrives from a pack, an update, or another tool cannot fetch
data with your profile's secrets without an explicit human decision.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_backend():
    path = ROOT / "dashboard" / "plugin_api.py"
    module_name = "provider_usage_plugin_api_approve"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def describe(preview: dict) -> str:
    refs = preview.get("credential_refs") or []
    if refs:
        lines = []
        for ref in refs:
            if ref.get("source") == "env":
                lines.append(f"  - environment variable: {ref.get('name')} (value is not read)")
            else:
                lines.append(
                    f"  - unsupported reference: {ref.get('provider')}.{ref.get('field')} "
                    "(schema v1 only supports env)"
                )
        ref_text = "\n".join(lines)
    else:
        ref_text = "  (none; this endpoint is public and needs no credential)"
    return (
        f"Definition : {preview.get('name')} ({preview.get('id')} v{preview.get('version')})\n"
        f"File       : {preview.get('file') or '(unknown)'}\n"
        f"Destination: {preview.get('endpoint')}\n"
        f"Host       : {preview.get('host')}\n"
        f"Credentials:\n{ref_text}\n"
        f"Fingerprint: sha256:{preview.get('digest')}\n"
        f"Approval   : {preview.get('approvals_file')}\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("definition", nargs="?", help="profile definition JSON file to approve")
    parser.add_argument("--revoke", metavar="ID", help="remove the local approval for this definition id")
    args = parser.parse_args()

    backend = load_backend()
    if args.revoke:
        try:
            removed = backend.remove_definition_approval(args.revoke)
        except ValueError as exc:
            print(f"cannot revoke approval: {exc}", file=sys.stderr)
            return 1
        print(f"{'revoked' if removed else 'no approval found for'} {args.revoke}")
        return 0 if removed else 1

    if not args.definition:
        parser.error("a definition file is required unless --revoke is used")
    source = Path(args.definition)
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        print(f"cannot read {source}: {type(exc).__name__}", file=sys.stderr)
        return 2
    definition, errors, warnings = backend._validate_definition(raw, source="profile", allow_override=True)
    if not definition:
        print("definition is invalid; nothing was approved", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1
    definition["_file"] = source.name
    preview = backend._definition_approval_preview(definition)
    preview["approvals_file"] = str(backend._definition_approval_path())
    print(describe(preview))
    for warning in warnings:
        print(f"Warning: {warning}")
    print(
        "Approval is bound to this exact content. Editing the definition revokes it.\n"
        "This is a local-user trust boundary: code running as the same user can still\n"
        "edit both files. It only prevents unreviewed definitions from using your secrets."
    )
    try:
        answer = input("Type 'approve' to confirm: ")
    except (EOFError, KeyboardInterrupt):
        answer = ""
    if answer.strip() != "approve":
        print("refused: no approval was written", file=sys.stderr)
        return 1
    try:
        backend.write_definition_approval(definition)
    except (OSError, ValueError) as exc:
        print(f"could not write approval: {exc}", file=sys.stderr)
        return 1
    print(f"approved {definition['id']} for this Hermes home")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
