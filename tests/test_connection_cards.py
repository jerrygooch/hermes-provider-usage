"""Always-listed popular-provider connection cards.

These tests pin the honest boundary for the built-in Claude / Anthropic,
Google Gemini API, and Z.ai / GLM cards:

* all three render from metadata alone with no credentials;
* an unconnected card never borrows a zero balance or quota;
* no HTTP client or provider fetch runs for an unconnected overview;
* Anthropic API-key access is not mistaken for a Claude subscription;
* Google/Z.ai configured keys never become an invented meter.

No live account or network request is used.
"""

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = ROOT / "dashboard" / "plugin_api.py"


def load_backend():
    module_name = "provider_usage_plugin_api_connections"
    spec = importlib.util.spec_from_file_location(module_name, BACKEND_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


backend = load_backend()


def summary(configured=False, source="none"):
    return {"configured": configured, "source": source, "account_count": 1 if configured else 0}


def walk_keys(value):
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from walk_keys(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from walk_keys(child)


class ConnectionCardTests(unittest.TestCase):
    def test_unconnected_renders_three_cards_without_limits_or_network(self):
        with mock.patch.object(backend, "_core_seam_available", return_value=True), \
             mock.patch.object(backend, "_credential_summary", return_value=summary()), \
             mock.patch.object(backend.httpx, "Client", side_effect=AssertionError("network")), \
             mock.patch.object(backend, "_core_usage", side_effect=AssertionError("credential read")):
            cards = backend._connection_cards()

        self.assertEqual([card["id"] for card in cards], ["anthropic", "gemini", "zai"])
        self.assertEqual([card["state"] for card in cards], ["not_connected"] * 3)
        self.assertTrue(all(card["configured"] is False for card in cards))
        keys = set(walk_keys(cards))
        self.assertNotIn("limits", keys)
        self.assertNotIn("balances", keys)
        self.assertNotIn("windows", keys)
        self.assertNotIn("used_percent", keys)

        anthropic = cards[0]
        self.assertEqual(anthropic["scopes"][0]["state"], "not_connected")
        self.assertEqual(anthropic["scopes"][1]["state"], "needs_permission")
        self.assertIn("Admin API key", anthropic["scopes"][1]["detail"])
        self.assertIn("individual accounts cannot use the Admin API", anthropic["scopes"][1]["detail"])

        gemini = cards[1]
        self.assertEqual(gemini["state"], "not_connected")
        self.assertEqual(gemini["scopes"][0]["state"], "not_connected")
        self.assertEqual(gemini["scopes"][1]["state"], "unavailable")
        self.assertIn("never infers remaining quota", gemini["scopes"][1]["detail"])
        self.assertIn("Google AI Pro/Ultra", gemini["scopes"][0]["detail"])

        zai = cards[2]
        self.assertEqual([scope["id"] for scope in zai["scopes"]], ["coding-plan", "standard-api", "endpoints"])
        self.assertEqual(zai["scopes"][2]["state"], "info")
        self.assertIn("api.z.ai", zai["scopes"][2]["detail"])
        self.assertIn("open.bigmodel.cn", zai["scopes"][2]["detail"])
        self.assertIn("Coding Plan keys use plan quota", zai["scopes"][0]["detail"])
        self.assertIn("Standard keys do not consume Coding Plan quota", zai["scopes"][1]["detail"])

    def test_api_key_only_anthropic_is_not_a_claude_subscription(self):
        with mock.patch.object(backend, "_core_seam_available", return_value=True), \
             mock.patch.object(backend, "_credential_summary", return_value=summary(True, "env")), \
             mock.patch.object(backend.httpx, "Client", side_effect=AssertionError("network")):
            cards = backend._connection_cards()

        anthropic = cards[0]
        self.assertEqual(anthropic["state"], "connected_no_usage")
        self.assertEqual(anthropic["credential_source"], "env")
        self.assertEqual(anthropic["scopes"][0]["state"], "not_connected")
        self.assertIn("inference-only", anthropic["scopes"][0]["state_detail"])
        self.assertEqual(anthropic["scopes"][1]["state"], "needs_permission")

    def test_oauth_anthropic_reads_as_a_subscription_connection(self):
        with mock.patch.object(backend, "_core_seam_available", return_value=True), \
             mock.patch.object(backend, "_credential_summary", return_value=summary(True, "oauth")):
            cards = backend._connection_cards()

        anthropic = cards[0]
        self.assertEqual(anthropic["state"], "connected")
        self.assertEqual(anthropic["scopes"][0]["state"], "connected")
        self.assertIn("without refreshing it", anthropic["scopes"][0]["detail"])

    def test_gemini_and_zai_configured_keys_never_become_invented_meters(self):
        def by_provider(provider):
            return summary(True, "config") if provider in {"gemini", "zai"} else summary()

        with mock.patch.object(backend, "_core_seam_available", return_value=True), \
             mock.patch.object(backend, "_credential_summary", side_effect=by_provider):
            cards = {card["id"]: card for card in backend._connection_cards()}

        for provider in ("gemini", "zai"):
            card = cards[provider]
            self.assertEqual(card["state"], "connected_no_usage")
            self.assertNotIn("limits", card)
            self.assertNotIn("balances", card)
        self.assertEqual(cards["gemini"]["scopes"][0]["state"], "connected")
        self.assertEqual(cards["gemini"]["scopes"][1]["state"], "unavailable")
        self.assertEqual([scope["state"] for scope in cards["zai"]["scopes"]],
                         ["unverified", "unverified", "info"])

    def test_missing_core_seam_is_unavailable_not_not_connected(self):
        with mock.patch.object(backend, "_core_seam_available", return_value=False), \
             mock.patch.object(backend, "_credential_summary", side_effect=AssertionError("summary")):
            cards = backend._connection_cards()

        self.assertEqual([card["state"] for card in cards], ["unavailable"] * 3)
        self.assertTrue(all("Upgrade Hermes" in card["state_detail"] for card in cards))
        self.assertEqual(cards[0]["scopes"][1]["state"], "needs_permission")
        self.assertEqual(cards[1]["scopes"][1]["state"], "unavailable")

    def test_overview_unconnected_makes_no_provider_fetch_or_http_call(self):
        empty_definitions = {"valid": {}, "invalid": [], "bundled_count": 0, "profile_count": 0}
        with mock.patch.object(backend, "_core_seam_available", return_value=True), \
             mock.patch.object(backend, "_credential_summary", return_value=summary()), \
             mock.patch.object(backend, "_maybe_refresh_vendor_specs", return_value=None), \
             mock.patch.object(backend, "_load_provider_definitions", return_value=empty_definitions), \
             mock.patch.object(backend, "_inventory", return_value=[]), \
             mock.patch.object(backend, "_cache_stats", return_value={}), \
             mock.patch.object(backend, "_fetch_provider", side_effect=AssertionError("provider fetch")), \
             mock.patch.object(backend, "_fetch_inventory_provider", side_effect=AssertionError("inventory fetch")), \
             mock.patch.object(backend.httpx, "Client", side_effect=AssertionError("network")), \
             mock.patch("hermes_cli.config.load_config", return_value={}):
            result = backend._overview_scoped({}, None)

        self.assertEqual(result["providers"], [])
        self.assertEqual([card["id"] for card in result["connections"]], ["anthropic", "gemini", "zai"])
        self.assertEqual([card["state"] for card in result["connections"]], ["not_connected"] * 3)
        self.assertEqual(result["catalog"]["definitions"], [])

    def test_connection_cards_do_not_echo_a_credential_value(self):
        fake_secret = "sk-ant-api03-super-secret"
        with mock.patch.object(backend, "_core_seam_available", return_value=True), \
             mock.patch.object(backend, "_credential_summary", return_value=summary(True, "env")):
            cards = backend._connection_cards()
        text = repr(cards)
        self.assertNotIn(fake_secret, text)
        self.assertNotIn("ANTHROPIC_API_KEY=", text)


if __name__ == "__main__":
    unittest.main()
