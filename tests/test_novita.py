"""Novita balance: integer strings in 1/10000 USD, mapped to real dollars."""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = ROOT / "dashboard" / "plugin_api.py"

_HOME = tempfile.mkdtemp(prefix="provider-usage-novita-home-")
os.environ["HERMES_HOME"] = _HOME


def load_backend():
    spec = importlib.util.spec_from_file_location("provider_usage_plugin_api_novita", BACKEND_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["provider_usage_plugin_api_novita"] = module
    spec.loader.exec_module(module)
    return module


class NovitaRowTest(unittest.TestCase):
    def setUp(self):
        self.api = load_backend()

    def test_it_converts_units_and_orders_the_balances(self):
        row = self.api._novita_row({
            "availableBalance": "250000", "cashBalance": "240000",
            "pendingCharges": "5000", "creditLimit": "1000000"})

        self.assertTrue(row["available"])
        self.assertEqual([item["label"] for item in row["balances"]],
                         ["Available balance", "Cash balance", "Pending charges", "Credit limit"])
        self.assertEqual(row["balances"][0]["amount"], 25.0)
        self.assertEqual(row["balances"][2]["amount"], 0.5)
        self.assertTrue(all(item["currency"] == "USD" for item in row["balances"]))
        self.assertTrue(any("1/10000" in detail for detail in row["details"]))

    def test_a_body_with_no_fields_is_unavailable_not_zero(self):
        row = self.api._novita_row({})
        self.assertFalse(row["available"])
        self.assertEqual(row["balances"], [])
        self.assertIn("no balance fields", row["unavailable_reason"])

    def test_the_row_carries_no_credential_text(self):
        row = self.api._novita_row({"availableBalance": "1"})
        self.assertNotIn("Authorization", repr(row))
        self.assertNotIn("Bearer", repr(row))


if __name__ == "__main__":
    unittest.main()
