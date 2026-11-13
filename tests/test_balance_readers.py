"""Balance readers normalize only what the provider documents, and never invent a unit."""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = ROOT / "dashboard" / "plugin_api.py"

_HOME = tempfile.mkdtemp(prefix="provider-usage-balances-home-")
os.environ["HERMES_HOME"] = _HOME


def load_backend():
    spec = importlib.util.spec_from_file_location("provider_usage_plugin_api_balances", BACKEND_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["provider_usage_plugin_api_balances"] = module
    spec.loader.exec_module(module)
    return module


class ArceeRowTest(unittest.TestCase):
    def setUp(self):
        self.api = load_backend()

    def test_tokens_are_details_and_never_a_fake_balance(self):
        row = self.api._arcee_row({"total_tokens": 1234567, "total_requests": 89, "date_range_days": 30})
        self.assertTrue(row["available"])
        self.assertEqual(row["balances"], [])
        self.assertIn("Tokens used: 1,234,567", row["details"])
        self.assertIn("Requests: 89", row["details"])
        self.assertEqual(row["capability"], "usage")

    def test_an_empty_body_is_unavailable(self):
        row = self.api._arcee_row({})
        self.assertFalse(row["available"])
        self.assertIn("no usage totals", row["unavailable_reason"])


class FireworksRowTest(unittest.TestCase):
    def setUp(self):
        self.api = load_backend()

    def test_the_currency_comes_from_the_response(self):
        row = self.api._fireworks_row({"lineItems": [
            {"series": "serverless", "totalCost": {"currencyCode": "USD", "units": 12, "nanos": 500000000}}]},
            "acme")
        self.assertEqual(row["balances"][0]["label"], "Serverless")
        self.assertEqual(row["balances"][0]["amount"], 12.5)
        self.assertEqual(row["balances"][0]["currency"], "USD")
        self.assertEqual(row["balances"][0]["kind"], "spend")

    def test_a_body_with_no_line_items_is_unavailable(self):
        row = self.api._fireworks_row({}, "acme")
        self.assertFalse(row["available"])
        self.assertIn("no billing line items", row["unavailable_reason"])


class DeepInfraRowTest(unittest.TestCase):
    def setUp(self):
        self.api = load_backend()

    def test_a_negative_stripe_balance_reads_as_credit_on_hand(self):
        row = self.api._deepinfra_row({"stripe_balance": -25.5, "scoped_credits": [{"remaining_cents": 1234}]})
        labels = [item["label"] for item in row["balances"]]
        self.assertEqual(labels, ["Credit available", "Scoped credits"])
        self.assertEqual(row["balances"][0]["amount"], 25.5)
        self.assertEqual(row["balances"][1]["amount"], 12.34)
        self.assertIn("negative Stripe balance", " ".join(row["details"]))

    def test_a_positive_stripe_balance_reads_as_amount_due(self):
        row = self.api._deepinfra_row({"stripe_balance": 10})
        self.assertEqual(row["balances"][0]["label"], "Amount due")
        self.assertEqual(row["balances"][0]["amount"], 10)

    def test_suspension_and_overdue_invoices_are_stated(self):
        row = self.api._deepinfra_row({"stripe_balance": -1, "suspended": True, "overdue_invoices": 2})
        self.assertIn("Account suspended: yes", row["details"])
        self.assertIn("Overdue invoices: 2", row["details"])

    def test_an_empty_body_is_unavailable(self):
        row = self.api._deepinfra_row({})
        self.assertFalse(row["available"])
        self.assertIn("no balance fields", row["unavailable_reason"])


if __name__ == "__main__":
    unittest.main()
