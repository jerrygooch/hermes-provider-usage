"""Uniform cards: one window vocabulary and order, whatever the provider calls its windows."""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = ROOT / "dashboard" / "plugin_api.py"

_HOME = tempfile.mkdtemp(prefix="provider-usage-cards-home-")
os.environ["HERMES_HOME"] = _HOME


def load_backend():
    spec = importlib.util.spec_from_file_location("provider_usage_plugin_api_cards", BACKEND_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["provider_usage_plugin_api_cards"] = module
    spec.loader.exec_module(module)
    return module


class WindowNormalizationTest(unittest.TestCase):
    def setUp(self):
        self.api = load_backend()

    def _row(self, *labels):
        return {"limits": [{"id": "default", "windows": [{"label": label, "used_percent": 10} for label in labels]}]}

    def test_every_window_gets_a_kind_while_the_provider_order_is_kept(self):
        row = self.api._normalize_card(self._row("Monthly", "Weekly limit", "5-hour session", "Daily"))
        self.assertEqual([window["kind"] for window in row["limits"][0]["windows"]],
                         ["monthly", "weekly", "five_hour", "daily"])
        self.assertEqual([window["label"] for window in row["limits"][0]["windows"]],
                         ["Monthly", "Weekly limit", "5-hour session", "Daily"])

    def test_an_explicit_kind_wins_over_the_label(self):
        row = self.api._normalize_card({"limits": [{"id": "default", "windows": [
            {"label": "Monthly quota", "kind": "weekly", "used_percent": 5}]}]})
        self.assertEqual(row["limits"][0]["windows"][0]["kind"], "weekly")

    def test_an_unknown_window_is_not_renamed(self):
        row = self.api._normalize_card(self._row("Weekly", "Project allowance"))
        self.assertEqual(row["limits"][0]["windows"][0]["kind"], "weekly")
        self.assertNotIn("kind", row["limits"][0]["windows"][1])

    def test_a_row_without_limits_is_left_alone(self):
        row = {"id": "novita", "balances": [{"label": "Available balance", "amount": 25.0}]}
        self.assertIs(self.api._normalize_card(row), row)

    def test_a_malformed_limits_list_does_not_raise(self):
        row = {"limits": [{"id": "default", "windows": "not-a-list"}, None, {"windows": [None, {}]}]}
        self.assertIs(self.api._normalize_card(row), row)


if __name__ == "__main__":
    unittest.main()
