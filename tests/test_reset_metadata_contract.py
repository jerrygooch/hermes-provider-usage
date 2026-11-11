"""Read-only reset metadata contract for the Codex provider row.

The production parser currently normalizes only the count fields from
``rate_limit_reset_credits``.  This suite pins that behaviour and the
no-inference rules that must survive the proposed additive inventory change.
It does not claim that per-credit ``entries`` or ``manage_url`` are implemented
today; those are specified in ``docs/reset-capabilities.md`` and must gain
their own tests when the parser supports them.

No live credential, provider request, account state, or network access is used.
"""

import copy
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = ROOT / "dashboard" / "plugin_api.py"


def load_backend():
    module_name = "provider_usage_plugin_api_reset_contract"
    spec = importlib.util.spec_from_file_location(module_name, BACKEND_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


backend = load_backend()


def _snapshot(payload):
    """Minimal duck-typed core snapshot; ``_fetch_codex`` reads ``raw`` only."""
    return SimpleNamespace(
        provider="openai-codex",
        source="usage_api",
        plan="plus",
        raw=payload,
        windows=(),
        details=(),
        unavailable_reason=None,
        fetched_at=None,
        identity_id=None,
        account_id=None,
        profile_scope=None,
    )


def _walk_keys(value):
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from _walk_keys(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from _walk_keys(child)


class ResetMetadataContractTests(unittest.TestCase):
    def _row(self, payload):
        with mock.patch.object(backend, "_core_seam_available", return_value=True), \
             mock.patch("agent.account_usage.fetch_account_usage",
                        return_value=_snapshot(payload)) as fetch:
            row = backend._fetch_codex()
        fetch.assert_called_once_with("openai-codex", read_only=True)
        return row

    def test_reported_counts_are_preserved(self):
        row = self._row({
            "plan_type": "plus",
            "rate_limit_reset_credits": {
                "available_count": 3,
                "applicable_available_count": 1,
            },
        })
        reset = row["reset_credits"]
        self.assertEqual(reset["available"], 3)
        self.assertEqual(reset["applicable"], 1)
        self.assertIs(type(reset["available"]), int)
        self.assertIs(type(reset["applicable"]), int)

    def test_missing_reset_block_never_invents_a_count(self):
        row = self._row({"plan_type": "plus"})
        reset = row["reset_credits"]
        if reset is not None:
            # A later link-only block is allowed, but it must not invent a
            # count or applicability when the provider said nothing.
            self.assertIsNone(reset.get("available"))
            self.assertIsNone(reset.get("applicable"))

    def test_explicit_zero_is_a_reading_not_absence(self):
        row = self._row({
            "plan_type": "plus",
            "rate_limit_reset_credits": {
                "available_count": 0,
                "applicable_available_count": 0,
            },
        })
        reset = row["reset_credits"]
        self.assertEqual(reset["available"], 0)
        self.assertEqual(reset["applicable"], 0)

    def test_detailed_payload_does_not_mutate_input_or_change_counts(self):
        payload = {
            "plan_type": "plus",
            "rate_limit_reset_credits": {
                "available_count": 2,
                "applicable_available_count": 1,
                "credits": [
                    {
                        "id": "credit-1",
                        "reset_type": "codex_rate_limits",
                        "status": "available",
                        "granted_at": "2026-06-17T00:00:00Z",
                        "expires_at": "2026-07-17T00:00:00Z",
                        "title": "Full reset",
                        "description": "Reset your current usage limits",
                    },
                    {
                        "id": "credit-2",
                        "reset_type": "codex_rate_limits",
                        "status": "available",
                        "granted_at": "2026-06-18T00:00:00Z",
                        "expires_at": None,
                        "title": None,
                        "description": None,
                    },
                ],
            },
        }
        before = copy.deepcopy(payload)
        row = self._row(payload)
        self.assertEqual(payload, before)
        reset = row["reset_credits"]
        self.assertEqual(reset["available"], 2)
        self.assertEqual(reset["applicable"], 1)

        # Forward-compatible: the current parser has no inventory rows.  If a
        # later parser adds them, they must be a verbatim projection of the
        # provider payload, never a derived or defaulted value.
        entries = reset.get("entries")
        if entries is not None:
            self.assertIsInstance(entries, list)
            self.assertEqual([entry["id"] for entry in entries], ["credit-1", "credit-2"])
            self.assertEqual(entries[0]["expires_at"], "2026-07-17T00:00:00Z")
            self.assertIsNone(entries[1]["expires_at"])
            self.assertEqual(entries[0]["status"], "available")
        else:
            self.assertNotIn("expires_at", reset)

    def test_no_expiry_is_invented_from_counts_or_plan(self):
        row = self._row({
            "plan_type": "pro",
            "rate_limit_reset_credits": {"available_count": 1},
        })
        reset = row["reset_credits"]
        expiry_keys = [key for key in _walk_keys(reset) if "expir" in str(key).lower()]
        self.assertEqual(expiry_keys, [])

    def test_summary_only_response_has_no_inventory_fields(self):
        row = self._row({
            "plan_type": "plus",
            "rate_limit_reset_credits": {"available_count": 1},
        })
        reset = row["reset_credits"]
        self.assertEqual(reset["available"], 1)
        self.assertIsNone(reset.get("entries"))


if __name__ == "__main__":
    unittest.main()
