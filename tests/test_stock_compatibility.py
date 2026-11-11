"""Stock-Hermes compatibility acceptance (pristine 0.23.1, no core patches).

Run against the stock checkout, not the enhanced seam worktree::

    PYTHONPATH=C:/Users/jerry/projects/provider-usage-stock-host \
        python -m unittest discover -s tests -p "test_stock_compatibility.py" -v

The real stock ``agent.account_usage.fetch_account_usage`` handler executes for
Codex, Anthropic, OpenRouter and the bundled Go provider hook. Only external
HTTP (httpx transport) and auth resolution are fixtures; no core helper is
replaced and no new core API is assumed. The suite skips itself on an enhanced
host, whose seam-specific suite lives in ``test_credential_migration_parity``.
"""

import contextlib
import copy
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx

ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = ROOT / "dashboard" / "plugin_api.py"

_HOME = tempfile.mkdtemp(prefix="provider-usage-stock-home-")
# Keep the real core's usage cache out of the daily Hermes home while this
# acceptance suite runs the stock handlers.
os.environ["HERMES_HOME"] = _HOME


def load_backend():
    module_name = "provider_usage_plugin_api_stock_compat"
    spec = importlib.util.spec_from_file_location(module_name, BACKEND_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


backend = load_backend()


def _is_stock_core():
    try:
        import agent.account_usage as core_usage
    except Exception:
        return False
    return not hasattr(core_usage, "provider_credential_summary")


STOCK = _is_stock_core()

CODEX_RAW = {
    "plan_type": "prolite",
    "rate_limit": {
        "allowed": True,
        "limit_reached": False,
        "primary_window": {"used_percent": 42.5, "reset_at": 1800000000, "limit_window_seconds": 18000},
        "secondary_window": {"used_percent": 17.0, "reset_at": 1800600000, "limit_window_seconds": 604800},
    },
    "credits": {"has_credits": True, "unlimited": False, "balance": 12.34},
    "rate_limit_reset_credits": {"available_count": 2, "applicable_available_count": 1},
    "model_usage": {"gpt-5.2-codex": {"available": True, "credits_would_enable": False}},
    "spend_control": {"reached": False, "individual_limit": 200.0},
}
ANTHROPIC_USAGE = {
    "five_hour": {"utilization": 25.0, "resets_at": "2026-11-11T20:00:00Z"},
    "seven_day": {"utilization": 50.0, "resets_at": "2026-11-17T00:00:00Z"},
    "seven_day_opus": {"utilization": 80.0, "resets_at": "2026-11-17T00:00:00Z"},
    "seven_day_sonnet": {"utilization": 10.0, "resets_at": "2026-11-17T00:00:00Z"},
    "extra_usage": {"is_enabled": True, "used_credits": 3.0, "monthly_limit": 20.0, "currency": "USD"},
}
OPENROUTER_CREDITS = {"total_credits": 100.0, "total_usage": 87.5}
OPENROUTER_KEY = {
    "limit": 50.0, "limit_remaining": 40.0, "limit_reset": "monthly",
    "usage": 87.5, "usage_daily": 1.25, "usage_weekly": 9.5, "usage_monthly": 40.0,
    "byok_usage": 4.0, "free_model_daily_requests": {"limit": 1000, "remaining": 750},
}
DEEPSEEK_BALANCE = {
    "is_available": True,
    "balance_infos": [
        {"currency": "USD", "total_balance": "12.50", "granted_balance": "2.00", "topped_up_balance": "10.50"},
        {"currency": "CNY", "total_balance": "88.00"},
    ],
}
OLLAMA_USAGE = {
    "limits": {
        "session": {"usage": 0.25},
        "weekly": {"usage": 0.50},
        "monthly": {"usage": 0.60, "models": {"glm-5.2": 31, "kimi-k2": 8}},
    },
    "activity": {"cost": "12.0", "period": {"type": "monthly"}},
    "range": "7d",
    "totals": {"request_count": 120, "usage_usd": 12.0,
               "input_tokens": 1000, "cached_input_tokens": 250, "output_tokens": 500},
    "buckets": [{"from": "2026-11-10", "usage_usd": 2.0, "request_count": 20}],
}
OLLAMA_BALANCE = {
    "included": {"allowance_usd": 20.0, "balance_usd": 8.0,
                 "period": {"until": "2026-12-01T00:00:00Z"}},
    "purchased": {"balance_usd": 2.5},
}
GO_USAGE = {"usage": {"rolling": {"percent": 55.0, "resetsAt": "2026-11-11T20:00:00Z"},
                      "weekly": {"percent": 20.0}, "monthly": {"percent": 10.0}}}
ZEN_MODELS = {"data": [{"id": "glm-5.2"}, {"id": "kimi-k2"}]}


def _json_response(payload, request=None):
    return httpx.Response(200, json=payload, request=request)


def mock_http(handler):
    """Patch only the HTTP transport; the real core fetchers/parsers stay live."""
    real_client = httpx.Client

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    return mock.patch.object(httpx, "Client", factory)


def _stock_route_handler(request):
    path = request.url.path
    if path.endswith("/usage") and "chatgpt.com" in str(request.url.host):
        return _json_response(copy.deepcopy(CODEX_RAW), request)
    if path.endswith("/api/oauth/usage"):
        return _json_response(copy.deepcopy(ANTHROPIC_USAGE), request)
    if path.endswith("/credits"):
        return _json_response({"data": copy.deepcopy(OPENROUTER_CREDITS)}, request)
    if path.endswith("/key"):
        return _json_response({"data": copy.deepcopy(OPENROUTER_KEY)}, request)
    if path.endswith("/user/balance"):
        return _json_response(copy.deepcopy(DEEPSEEK_BALANCE), request)
    if path.endswith("/api/usage"):
        return _json_response(copy.deepcopy(OLLAMA_USAGE), request)
    if path.endswith("/api/balance"):
        return _json_response(copy.deepcopy(OLLAMA_BALANCE), request)
    if path.endswith("/zen/go/v1/usage"):
        return _json_response(copy.deepcopy(GO_USAGE), request)
    if path.endswith("/zen/v1/models"):
        return _json_response(copy.deepcopy(ZEN_MODELS), request)
    return httpx.Response(404, json={}, request=request)


@unittest.skipUnless(STOCK, "stock-Hermes compatibility suite (enhanced core runs the seam suite)")
class StockCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = Path(_HOME)
        (cls.home / ".env").write_text("", encoding="utf-8")

    def setUp(self):
        os.environ["HERMES_HOME"] = str(self.home)
        backend._clear_account_caches()
        self.addCleanup(backend._clear_account_caches)

    @contextlib.contextmanager
    def stock_auth(self, **overrides):
        secrets = {"OPENROUTER_API_KEY": "fixture-openrouter", "DEEPSEEK_API_KEY": "fixture-deepseek",
                   "OLLAMA_API_KEY": "fixture-ollama", "OPENCODE_ZEN_API_KEY": "fixture-zen"}
        secrets.update({key: value for key, value in overrides.items() if value is not None})
        for key, value in overrides.items():
            if value is None:
                secrets.pop(key, None)
        with mock.patch("agent.secret_scope.get_secret",
                        side_effect=lambda name, default=None: secrets.get(name, default)), \
             mock.patch("agent.account_usage.resolve_anthropic_token",
                        return_value="sk-ant-oat-fixture"), \
             mock.patch("agent.account_usage._resolve_codex_usage_credentials",
                        return_value=("fixture-codex-token", "https://chatgpt.com/backend-api", None)), \
             mock.patch("agent.account_usage.resolve_runtime_provider",
                        side_effect=lambda **kwargs: {
                            "api_key": "fixture-openrouter",
                            "base_url": "https://openrouter.ai/api/v1",
                        }), \
             mock.patch("hermes_cli.runtime_provider.resolve_runtime_provider",
                        side_effect=lambda **kwargs: {
                            "api_key": "fixture-go",
                            "base_url": "https://opencode.ai/zen/go",
                        }):
            yield

    def test_stock_has_the_read_only_snapshot_route_and_no_enhanced_helpers(self):
        import agent.account_usage as core_usage

        self.assertTrue(backend._core_seam_available())
        self.assertFalse(hasattr(core_usage, "provider_credential_summary"))
        self.assertFalse(hasattr(core_usage, "list_account_usage_identities"))
        self.assertIn("openai-codex", core_usage._READ_ONLY_USAGE_FETCHERS)

    def test_codex_uses_real_stock_fetcher_and_keeps_raw_groups(self):
        with self.stock_auth(), mock_http(_stock_route_handler):
            row = backend._fetch_codex()
        self.assertTrue(row["available"])
        self.assertEqual(row["id"], "openai-codex")
        self.assertEqual(row["plan"], "ChatGPT Pro 5x")
        self.assertTrue(row["limits"])
        self.assertEqual(row["credit_status"]["enabled"], True)
        self.assertIsNotNone(row["reset_credits"])
        self.assertTrue(row["model_access"])
        self.assertTrue(row["spend_control"])
        self.assertNotIn("Upgrade Hermes", str(row))

    def test_anthropic_uses_real_stock_fetcher_not_an_upgrade_row(self):
        with self.stock_auth(), mock_http(_stock_route_handler):
            row = backend._fetch_anthropic()
        self.assertTrue(row["available"])
        self.assertEqual(len(row["limits"][0]["windows"]), 4)
        self.assertEqual(row["limits"][0]["windows"][2].get("scope"), "model")
        self.assertTrue(any("Extra usage" in detail for detail in row["details"]))

    def test_openrouter_stock_core_plus_profile_key_restores_key_usage(self):
        with self.stock_auth(), mock_http(_stock_route_handler):
            row = backend._fetch_openrouter()
        self.assertTrue(row["available"])
        self.assertEqual(row["balances"][0]["total"], 100.0)
        self.assertEqual(row["balances"][0]["used"], 87.5)
        self.assertEqual(row["key_usage"]["daily"], 1.25)
        self.assertTrue(any(group["label"] == "Free models" for group in row["limits"]))
        self.assertTrue(any("OPENROUTER_API_KEY" in detail for detail in row["details"]))

    def test_deepseek_balance_uses_profile_key_and_fixed_origin(self):
        with self.stock_auth(), mock_http(_stock_route_handler):
            row = backend._fetch_deepseek()
        self.assertTrue(row["available"])
        self.assertEqual({item["currency"] for item in row["balances"]}, {"USD", "CNY"})
        usd = next(item for item in row["balances"] if item["currency"] == "USD")
        self.assertEqual(usd["granted"], 2.0)
        self.assertEqual(usd["topped_up"], 10.5)
        self.assertTrue(any("DEEPSEEK_API_KEY" in detail for detail in row["details"]))

    def test_ollama_usage_activity_and_balance_use_profile_key(self):
        with self.stock_auth(), mock_http(_stock_route_handler):
            row = backend._fetch_ollama_cloud()
        self.assertTrue(row["available"])
        self.assertTrue(row["limits"])
        self.assertTrue(row["activity"])
        self.assertTrue(any("OLLAMA_API_KEY" in detail for detail in row["details"]))

    def test_zen_access_is_verified_without_inventing_a_wallet(self):
        with self.stock_auth(), mock_http(_stock_route_handler):
            row = backend._fetch_opencode_zen()
        self.assertTrue(row["available"])
        self.assertTrue(row["products"])
        self.assertFalse(row["balances"])
        self.assertTrue(any("not exposed" in detail for detail in row["details"]))

    def test_go_uses_the_bundled_stock_provider_hook(self):
        with self.stock_auth(), mock_http(_stock_route_handler):
            row = backend._fetch_opencode_go()
        self.assertTrue(row["available"])
        self.assertEqual(len(row["products"]), 2)
        self.assertEqual([window["label"] for window in row["limits"][0]["windows"]],
                         ["5-hour", "Weekly", "Monthly"])

    def test_nous_uses_stock_core_builder_without_importing_private_auth(self):
        from hermes_cli.nous_account import NousPortalAccountInfo, NousPortalSubscriptionInfo

        account = NousPortalAccountInfo(
            logged_in=True, source="account_api", fresh=True,
            portal_base_url="https://portal.example.test",
            subscription=NousPortalSubscriptionInfo(
                plan="Nous Pro", monthly_credits=100.0, credits_remaining=40.0),
        )
        with mock.patch("agent.account_usage._fetch_portal_account", return_value=account):
            row = backend._fetch_nous()
        self.assertTrue(row["available"])
        self.assertEqual(row["plan"], "Nous Pro")
        self.assertEqual(row["limits"][0]["windows"][0]["label"], "Subscription")
        self.assertEqual(row["limits"][0]["windows"][0]["used_percent"], 60.0)

    def test_xai_stays_unavailable_with_an_official_link_not_a_token_read(self):
        with mock.patch("hermes_cli.plugin_provider_requests.credentialed_provider_request",
                        side_effect=ValueError("No signed-in requests for provider 'xai-oauth'")), \
             mock.patch.object(backend, "httpx") as fake_httpx:
            fake_httpx.Client.side_effect = AssertionError("xAI must not call with a raw token")
            row = backend._fetch_xai()
        self.assertFalse(row["available"])
        self.assertIn("does not broker xAI", row["unavailable_reason"])
        self.assertNotIn("622eb3219f", row["unavailable_reason"])
        self.assertTrue(any(link["url"] == "https://grok.com/dashboard" for link in row["manage_links"]))

    def test_popular_cards_use_profile_env_presence_without_a_summary_helper(self):
        with self.stock_auth(ANTHROPIC_API_KEY="fixture-anthropic"), \
             mock.patch.object(httpx, "Client", side_effect=AssertionError("cards must not fetch")):
            cards = {card["id"]: card for card in backend._connection_cards()}
        self.assertEqual(cards["anthropic"]["state"], "connected_no_usage")
        self.assertEqual(cards["anthropic"]["credential_source"], "env")
        self.assertEqual(cards["anthropic"]["scopes"][0]["state"], "unverified")
        self.assertNotEqual(cards["anthropic"]["scopes"][0]["state"], "not_connected")
        self.assertEqual(cards["gemini"]["state"], "not_connected")
        self.assertEqual(cards["zai"]["state"], "not_connected")
        self.assertNotIn("limits", cards["anthropic"])

    def test_unknown_oauth_anthropic_is_not_called_not_connected(self):
        with self.stock_auth(ANTHROPIC_API_KEY=None, GEMINI_API_KEY=None, GOOGLE_API_KEY=None,
                             GLM_API_KEY=None, ZAI_API_KEY=None, Z_AI_API_KEY=None):
            cards = {card["id"]: card for card in backend._connection_cards()}
        self.assertEqual(cards["anthropic"]["state"], "unavailable")
        self.assertIn("cannot verify", cards["anthropic"]["state_detail"])

    def test_stock_has_no_account_identity_inventory_so_footer_stays_unknown(self):
        self.assertEqual(backend._account_identities("openrouter"), [])
        row = backend._base("openrouter", title="OpenRouter credits", source="credits_api")
        attached = backend._attach_accounts("openrouter", row)
        self.assertNotIn("accounts", attached)
        self.assertEqual(backend._verified_row_identity(attached), "")
        self.assertNotIn("identity_id", attached)

    def test_reset_service_is_part_of_the_plugin_source(self):
        self.assertTrue((ROOT / "dashboard" / "reset_service.py").is_file())
        module = backend._reset_service_module()
        self.assertTrue(callable(getattr(module, "ResetService", None)))

    def test_missing_reset_service_is_an_honest_unavailable_not_an_exception(self):
        previous = getattr(backend, "_RESET_SERVICE_MODULE", None)
        setattr(backend, "_RESET_SERVICE_MODULE", None)
        self.addCleanup(setattr, backend, "_RESET_SERVICE_MODULE", previous)
        missing = Path(_HOME) / "reset-service-not-installed.py"
        with mock.patch.object(backend, "_reset_service_path", return_value=missing):
            self.assertIsNone(backend._reset_service_module())
            payload = backend.reset_summary(None, {})
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["state"], "unavailable")
        self.assertEqual(payload["reason"], "reset_service_unavailable")
        self.assertFalse(payload["needs_reconcile"])
        self.assertEqual(payload["credit_consumed"], "no")
        self.assertIn("Nothing was spent", payload["message"])

    def test_overview_runs_stock_handlers_without_upgrade_rows(self):
        empty_definitions = {"valid": {}, "invalid": [], "bundled_count": 0, "profile_count": 0}
        config = {
            "model": {"provider": "openai-codex"},
            "fallback_providers": [{"provider": "anthropic"}, {"provider": "opencode-go"}],
        }
        with self.stock_auth(), mock_http(_stock_route_handler), \
             mock.patch("hermes_cli.config.load_config", return_value=config), \
             mock.patch.object(backend, "_maybe_refresh_vendor_specs"), \
             mock.patch.object(backend, "_pricing_rows", return_value=[]), \
             mock.patch.object(backend, "_load_provider_definitions",
                               return_value=empty_definitions):
            data = backend._overview_scoped({}, None)
        rows = {row["id"]: row for row in data["providers"]}
        for provider in ("openai-codex", "anthropic", "opencode-go", "openrouter",
                         "deepseek", "ollama-cloud", "opencode-zen"):
            self.assertIn(provider, rows)
            self.assertTrue(rows[provider]["available"], provider)
            self.assertNotIn("Upgrade Hermes", str(rows[provider]))
        self.assertEqual([row["id"] for row in data["connections"]],
                         ["anthropic", "gemini", "zai"])

    def test_direct_endpoint_refuses_redirects_and_foreign_hosts(self):
        real_client = httpx.Client

        def redirect(request):
            return httpx.Response(302, headers={"location": "https://evil.example/"}, request=request)

        def factory(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(redirect)
            return real_client(*args, **kwargs)

        with mock.patch.object(httpx, "Client", factory):
            with self.assertRaises(RuntimeError):
                backend._fixed_provider_get("https://api.deepseek.com/user/balance", "fixture",
                                            host="api.deepseek.com")
        with self.assertRaises(RuntimeError):
            backend._fixed_provider_get("https://evil.example/user/balance", "fixture",
                                        host="api.deepseek.com")


if __name__ == "__main__":
    unittest.main()
