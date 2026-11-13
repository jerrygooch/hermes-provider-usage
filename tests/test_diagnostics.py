"""Diagnostics + failure-reporting contract (0.10.1).

A provider read that fails must be *visible*: the host log gets one WARNING with the
provider and a redacted reason, and ``GET /diagnostics`` reports the last refresh's
rows, timings and failures. These assertions cover the seam itself, not a live account.
"""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = ROOT / "dashboard" / "plugin_api.py"

_HOME = tempfile.mkdtemp(prefix="provider-usage-diagnostics-home-")
os.environ["HERMES_HOME"] = _HOME


def load_backend():
    module_name = "provider_usage_plugin_api_diagnostics"
    spec = importlib.util.spec_from_file_location(module_name, BACKEND_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class FailureSummaryTest(unittest.TestCase):
    def setUp(self):
        self.api = load_backend()

    def test_summary_names_the_error_type_and_stays_bounded(self):
        summary = self.api._failure_summary(TimeoutError("read timed out after 12s"))
        self.assertIn("TimeoutError", summary)
        self.assertLessEqual(len(summary), 300)
        self.assertLessEqual(len(self.api._failure_summary(RuntimeError("x" * 900))), 300)

    def test_summary_never_carries_a_credential_shaped_value(self):
        secret = "sk-live-" + "a" * 40
        summary = self.api._failure_summary(RuntimeError(f"Authorization: Bearer {secret}"))
        # The redaction helper may keep a prefix, but the full value must not survive.
        self.assertNotIn(secret, summary)


class DiagnosticsRouteTest(unittest.TestCase):
    def setUp(self):
        self.api = load_backend()

    def test_diagnostics_is_registered_as_a_get_route(self):
        paths = {(getattr(route, "path", ""), tuple(sorted(getattr(route, "methods", ()) or ())))
                 for route in self.api.router.routes}
        self.assertIn(("/diagnostics", ("GET",)), paths)

    def test_diagnostics_reports_version_deadline_and_no_last_overview(self):
        self.api._LAST_OVERVIEW.clear()
        payload = self.api.diagnostics()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["plugin"], "jg-provider-usage")
        self.assertEqual(payload["version"], "0.10.1")
        self.assertEqual(payload["deadline_s"], 18.0)
        self.assertIsNone(payload["last_overview"])
        self.assertIsInstance(payload["credentials"], dict)

    def test_diagnostics_returns_the_recorded_refresh(self):
        self.api._LAST_OVERVIEW.clear()
        self.api._LAST_OVERVIEW.update({
            "at": "2026-01-01T00:00:00Z",
            "profile": "default",
            "duration_ms": 812,
            "providers": ["deepseek", "openrouter"],
            "unavailable": ["openrouter"],
            "failures": {"openrouter": "TimeoutError: read timed out"},
            "timings_ms": {"deepseek": 140.0, "openrouter": None},
            "active_provider": "deepseek",
        })
        payload = self.api.diagnostics()
        last = payload["last_overview"]
        self.assertEqual(last["providers"], ["deepseek", "openrouter"])
        self.assertEqual(last["failures"]["openrouter"], "TimeoutError: read timed out")
        self.assertIsNone(last["timings_ms"]["openrouter"])

    def test_diagnostics_copy_is_detached_from_the_live_record(self):
        self.api._LAST_OVERVIEW.clear()
        self.api._LAST_OVERVIEW.update({"providers": ["deepseek"], "failures": {}})
        payload = self.api.diagnostics()
        payload["last_overview"]["providers"].append("mutated")
        self.assertEqual(self.api._LAST_OVERVIEW["providers"], ["deepseek"])


class OverviewDeadlineTest(unittest.TestCase):
    def setUp(self):
        self.api = load_backend()

    def test_deadline_sits_inside_the_desktop_request_cap(self):
        # The desktop aborts a plugin request at 25s; the backend must answer sooner.
        self.assertLess(self.api._OVERVIEW_DEADLINE_S, 25.0)


if __name__ == "__main__":
    unittest.main()
