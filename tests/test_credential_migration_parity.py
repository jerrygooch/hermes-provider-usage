"""Whole-plugin feature-parity baseline and migration acceptance tests.

Two layers live here, deliberately separated:

**Baseline (runs in the normal suite, must stay green).**
    Every built-in provider adapter is driven through its REAL normalizer with a
    sanitized synthetic payload and a mocked transport (no account is contacted,
    no credential leaves the process).  The assertions are the data contract the
    Desktop pane consumes: limit groups and window labels, balances and their
    currency/component fields, details, activity buckets, product splits,
    credits/reset credits, model access, spend control, key usage, plus the
    inventory / profile-selection, declarative catalog, trust gate and
    setup metadata.  A credential migration may change *how* a body is fetched;
    it must not change this row shape.

**Future acceptance (skipped unless HERMES_PU_ACCEPT_MIGRATION=1).**
    The catalog rule-11 end state: no adapter or inventory path resolves a raw
    runtime key or reads a credential store; the sanctioned routes
    (``agent.secret_scope.get_secret``, ``credentialed_provider_request``,
    ``fetch_account_usage(..., read_only=True)``) carry the credential; the
    parity field set survives; the core snapshot route keeps OpenRouter's full
    credit/key detail.  Run them to see the remaining blockers::

        HERMES_PU_ACCEPT_MIGRATION=1 python -m unittest \
            tests.test_credential_migration_parity -v

``CurrentNarrowingProbes`` locks today's narrowing (one row per provider, core
OpenRouter snapshot drops money/key detail).  Those probes are green now and
must be *updated*, not deleted, when the core seams in
``docs/credential-migration-parity.md`` land.
"""

import contextlib
import copy
import importlib.util
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import httpx

ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = ROOT / "dashboard" / "plugin_api.py"

# A synthetic credential value.  It is asserted absent from every returned row
# and from every error string; nothing here is a real key.
SECRET = "sk-synthetic-parity-0000000000000000"
MIGRATION_ACCEPTANCE = os.environ.get("HERMES_PU_ACCEPT_MIGRATION") == "1"
try:
    from agent import account_usage as _core_usage_module
    STOCK_CORE = not hasattr(_core_usage_module, "provider_credential_summary")
except Exception:
    STOCK_CORE = True


def load_backend():
    module_name = "provider_usage_plugin_api_parity"
    spec = importlib.util.spec_from_file_location(module_name, BACKEND_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


backend = load_backend()

# The row keys ``desktop/plugin.js`` reads.  ``_base`` seeds all of them, so a
# serializer that forgets one breaks a panel silently.
UI_ROW_KEYS = (
    "id", "label", "available", "configured", "capability", "source",
    "fetched_at", "title", "plan", "limits", "balances", "credit_status",
    "model_access", "reset_credits", "spend_control", "renewal_at", "pricing",
    "demand", "peak", "cache", "activity", "key_usage", "products",
    "breakdown", "breakdown_note", "details", "unavailable_reason",
)


def now():
    return datetime.now(timezone.utc)


def snapshot(provider, *, title="Account limits", source="usage_api", plan=None,
             windows=(), details=(), unavailable_reason=None, identity=None,
             raw=None, fetched_at=None, identity_id=None, account_id=None,
             profile_scope=None):
    """Build a real core ``AccountUsageSnapshot`` without importing core eagerly."""
    import inspect

    from agent.account_usage import AccountUsageSnapshot, AccountUsageWindow

    parsed = tuple(
        item if isinstance(item, AccountUsageWindow) else AccountUsageWindow(**item)
        for item in windows
    )
    values = {
        "provider": provider,
        "source": source,
        "fetched_at": fetched_at or now(),
        "title": title,
        "plan": plan,
        "windows": parsed,
        "details": tuple(details),
        "unavailable_reason": unavailable_reason,
        "identity": identity,
        "raw": raw,
        "identity_id": identity_id,
        "account_id": account_id,
        "profile_scope": profile_scope,
    }
    supported = inspect.signature(AccountUsageSnapshot).parameters
    return AccountUsageSnapshot(**{key: value for key, value in values.items() if key in supported})


@contextlib.contextmanager
def mock_core_usage(snapshots, calls=None):
    """Serve the sanctioned core snapshot route with synthetic snapshots only.

    ``snapshots`` is ``{provider: snapshot}``, ``{(provider, identity_id):
    snapshot}``, or a callable ``(provider, identity_id) -> snapshot``.  The real
    ``agent.account_usage.fetch_account_usage`` is replaced here; that is the
    migration seam, not a data assertion.
    """
    def fake(provider, **kwargs):
        identity_id = kwargs.get("identity_id")
        if calls is not None:
            calls.append((provider, kwargs))
        if callable(snapshots):
            return snapshots(provider, identity_id)
        if (provider, identity_id) in snapshots:
            return snapshots[(provider, identity_id)]
        return snapshots.get(provider)

    with mock.patch("agent.account_usage.fetch_account_usage", side_effect=fake):
        yield


def json_response(payload, *, request, status=200):
    return httpx.Response(status, json=payload, request=request)


def serve(routes, *, fallback_status=404):
    """httpx.MockTransport handler: ``routes`` is a list of (path suffix, payload)."""

    def handler(request):
        path = request.url.path
        for suffix, payload in routes:
            if path.endswith(suffix):
                if callable(payload):
                    return payload(request)
                return json_response(payload, request=request)
        return httpx.Response(fallback_status, json={}, request=request)

    return handler


@contextlib.contextmanager
def mock_http(routes=None, *, handler=None):
    """Route every ``httpx.Client`` the plugin/core constructs through a mock."""
    transport = httpx.MockTransport(handler or serve(routes or []))
    real_client = httpx.Client

    def factory(*args, **kwargs):
        kwargs["transport"] = transport
        kwargs.setdefault("timeout", 5.0)
        return real_client(*args, **kwargs)

    with mock.patch.object(httpx, "Client", side_effect=factory):
        yield transport


@contextlib.contextmanager
def mock_xai_broker(routes=None, *, handler=None):
    """Serve the sanctioned xAI broker contract with synthetic bodies only.

    The real ``credentialed_provider_request`` is replaced here; that is the
    migration seam, not a data assertion.  Payloads may be dicts, bytes, or a
    callable returning an ``httpx.Response``.
    """
    def fake(provider, method, url, **kwargs):
        from hermes_cli.plugin_provider_requests import ProviderResponse

        assert provider == "xai-oauth", provider
        request = httpx.Request(method, url)
        if handler is not None:
            answer = handler(request, kwargs)
        else:
            answer = None
            for suffix, payload in routes or []:
                if request.url.path.endswith(suffix):
                    answer = payload(request) if callable(payload) else payload
                    break
        if isinstance(answer, httpx.Response):
            return ProviderResponse(status=answer.status_code, headers=dict(answer.headers),
                                    body=answer.content)
        if isinstance(answer, bytes):
            return ProviderResponse(status=200, headers={"content-type": "application/octet-stream"},
                                    body=answer)
        if answer is None:
            return ProviderResponse(status=404, headers={"content-type": "application/json"},
                                    body=b"{}")
        return ProviderResponse(status=200, headers={"content-type": "application/json"},
                                body=json.dumps(answer).encode())

    with mock.patch("hermes_cli.plugin_provider_requests.credentialed_provider_request",
                    side_effect=fake):
        yield


class ParityCase(unittest.TestCase):
    """Isolated home, no network, secret-material assertions on every row."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.home = root / "home"
        self.home.mkdir()
        self.defs = root / "defs"
        self.defs.mkdir()
        env = mock.patch.dict(os.environ, {
            "HERMES_HOME": str(self.home),
            "HERMES_PROVIDER_USAGE_DEFINITIONS": str(self.defs),
        })
        env.start()
        self.addCleanup(env.stop)
        backend._DEFINITION_CACHE.clear()
        self.addCleanup(backend._DEFINITION_CACHE.clear)
        backend._clear_account_caches()
        self.addCleanup(backend._clear_account_caches)
        if not MIGRATION_ACCEPTANCE:
            # Baseline tests mock the sanctioned snapshot route directly and
            # must run against any core that can import AccountUsageSnapshot.
            # The gated acceptance suite exercises the real seam instead.
            seam = mock.patch.object(backend, "_core_seam_available", return_value=True)
            seam.start()
            self.addCleanup(seam.stop)

    # -- helpers ---------------------------------------------------------
    def runtime(self, provider="openrouter", *, base_url="https://openrouter.ai/api/v1",
                api_key=SECRET):
        """Deprecated test shim: no adapter has a raw runtime path any more."""
        raise AssertionError("raw runtime credentials must not be available to the plugin")

    def assert_clean(self, row):
        text = json.dumps(row, default=str)
        self.assertNotIn(SECRET, text, "credential value leaked into a provider row")
        stack = [row]
        while stack:
            item = stack.pop()
            if isinstance(item, dict):
                for key, value in item.items():
                    self.assertNotIn(
                        str(key).lower(), {"authorization", "api_key", "access_token", "refresh_token"},
                        "credential field leaked into a provider row",
                    )
                    stack.append(value)
            elif isinstance(item, (list, tuple)):
                stack.extend(item)

    def assert_ui_contract(self, row):
        missing = [key for key in UI_ROW_KEYS if key not in row]
        self.assertEqual(missing, [], f"{row.get('id')} row is missing UI fields")
        self.assert_clean(row)
        json.dumps(row)  # the REST boundary must stay JSON-serializable


# ---------------------------------------------------------------------------
# Built-in provider parity
# ---------------------------------------------------------------------------

CODEX_RAW = {
    "plan_type": "prolite",
    "rate_limit": {
        "allowed": True,
        "limit_reached": False,
        "primary_window": {"used_percent": 42.5, "reset_at": 1800000000, "limit_window_seconds": 18000},
        "secondary_window": {"used_percent": 17.0, "reset_at": 1800600000, "limit_window_seconds": 604800},
    },
    "additional_rate_limits": [
        {
            "limit_name": "gpt-5-codex-spark",
            "rate_limit": {
                "allowed": True,
                "limit_reached": False,
                "primary_window": {"used_percent": 88.0, "reset_at": 1800003600, "limit_window_seconds": 18000},
            },
        }
    ],
    "code_review_rate_limit": {
        "allowed": False,
        "limit_reached": True,
        "primary_window": {"used_percent": 100.0, "reset_at": 1800007200, "limit_window_seconds": 3600},
    },
    "credits": {
        "has_credits": True,
        "unlimited": False,
        "balance": 12.34,
        "overage_limit_reached": True,
        "approx_local_messages": [10, 20],
        "approx_cloud_messages": [1, 2],
    },
    "rate_limit_reset_credits": {"available_count": 3, "applicable_available_count": 1},
    "model_usage": {
        "gpt-5.2-codex": {"available": True, "credits_would_enable": False},
        "gpt-5.1-codex-spark": {
            "available": False,
            "available_at": "2026-12-01T00:00:00Z",
            "credits_would_enable": True,
        },
    },
    "spend_control": {"reached": False, "individual_limit": 200.0},
    "rate_limit_reached_type": "workspace_member_usage_limit",
}

OPENROUTER_CREDITS = {"total_credits": 100.0, "total_usage": 87.5}
OPENROUTER_KEY = {
    "limit": 50.0,
    "limit_remaining": 12.5,
    "limit_reset": "monthly",
    "usage": 87.5,
    "usage_daily": 1.25,
    "usage_weekly": 9.5,
    "usage_monthly": 40.0,
    "byok_usage": 4.0,
    "free_model_daily_requests": {"limit": 1000, "remaining": 250},
}

DEEPSEEK_BALANCE = {
    "is_available": True,
    "balance_infos": [
        {"currency": "usd", "total_balance": "12.34", "granted_balance": "2.00", "topped_up_balance": "10.34"},
        {"currency": "cny", "total_balance": "88.00"},
    ],
}

OLLAMA_USAGE = {
    "limits": {
        "session": {"usage": 0.4},
        "weekly": {"usage": 0.55},
        "monthly": {"usage": 1.0, "models": {"gpt-oss:120b": {"request_count": 12}}},
    },
    "activity": {"cost": "0.42", "period": {"type": "monthly"}},
    "totals": {
        "request_count": 1200,
        "usage_usd": 3.5,
        "input_tokens": 1_000_000,
        "cached_input_tokens": 250_000,
        "output_tokens": 500_000,
    },
    "range": "7d",
    "buckets": [{"from": "2026-11-10", "usage_usd": 0.5, "request_count": 100}],
}

OLLAMA_BALANCE = {
    "included": {
        "allowance_usd": 20.0,
        "balance_usd": 5.0,
        "period": {"until": "2026-12-01T00:00:00Z"},
    },
    "purchased": {"balance_usd": 2.5},
}

GROK_PROXY = {
    "config": {
        "creditUsagePercent": 62.5,
        "currentPeriod": {"type": "WEEKLY", "end": "2026-11-18T00:00:00Z"},
        "productUsage": [
            {"product": "GrokChat", "usagePercent": 30.0},
            {"product": "GrokImagine", "usagePercent": 32.5},
        ],
        "prepaidBalance": {"val": 1500},
        "topUpMethod": "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
        "isUnifiedBillingUser": True,
    }
}
GROK_SETTINGS = {"subscription_tier_display": "SuperGrok Heavy"}


class CodexParityTests(ParityCase):
    def _row(self, raw, **fields):
        with mock.patch("agent.account_usage.fetch_account_usage",
                        return_value=snapshot("openai-codex", raw=raw, **fields)) as fetch:
            row = backend._fetch_codex()
        return row, fetch

    def test_raw_payload_keeps_every_codex_group(self):
        row, fetch = self._row(copy.deepcopy(CODEX_RAW))
        self.assert_ui_contract(row)
        fetch.assert_called_once_with("openai-codex", read_only=True)
        self.assertEqual(row["plan"], "ChatGPT Pro 5x")
        self.assertEqual(row["source"], "usage_api")
        self.assertEqual([group["id"] for group in row["limits"]],
                         ["default", "gpt-5-codex-spark", "code-review"])
        default = row["limits"][0]
        self.assertEqual([window["label"] for window in default["windows"]], ["5-hour", "Weekly"])
        self.assertEqual([window["used_percent"] for window in default["windows"]], [42.5, 17.0])
        self.assertTrue(default["allowed"])
        self.assertFalse(default["limit_reached"])
        self.assertEqual(row["limits"][1]["windows"][0]["label"], "GPT-5-Codex-Spark · 5-hour")
        self.assertEqual(row["limits"][2]["label"], "Code review")
        self.assertFalse(row["limits"][2]["allowed"])
        self.assertEqual(row["balances"],
                         [{"label": "Extra usage balance", "amount": 12.34, "currency": "USD"}])
        self.assertEqual(row["credit_status"], {
            "enabled": True,
            "unlimited": False,
            "overage_limit_reached": True,
            "approx_local_messages": [10, 20],
            "approx_cloud_messages": [1, 2],
        })
        self.assertEqual(row["reset_credits"]["available"], 3)
        self.assertEqual(row["reset_credits"]["applicable"], 1)
        self.assertEqual(row["reset_credits"]["entries"], None)
        self.assertEqual([entry["model"] for entry in row["model_access"]],
                         ["Gpt 5.2 Codex", "GPT-5.1-Codex-Spark"])
        self.assertTrue(row["model_access"][1]["credits_would_enable"])
        self.assertTrue(row["model_access"][1]["available_at"].endswith("Z"))
        self.assertEqual(row["spend_control"], {"reached": False, "individual_limit": 200.0})
        self.assertIn("Rate limit reached: Workspace Member Usage Limit", row["details"])
        self.assertTrue(row["available"])

    def test_snapshot_without_raw_still_reports_windows_and_details(self):
        row, _ = self._row(
            None,
            title="Codex limits",
            windows=[{"label": "5-hour", "used_percent": 12.0},
                     {"label": "Weekly", "used_percent": 34.0}],
            details=("You have 2 resets banked",),
        )
        self.assert_ui_contract(row)
        self.assertEqual([window["label"] for window in row["limits"][0]["windows"]],
                         ["5-hour", "Weekly"])
        self.assertEqual(row["limits"][0]["label"], "Codex")
        self.assertEqual(row["details"], ["You have 2 resets banked"])
        self.assertTrue(row["available"])

    def test_snapshot_only_build_keeps_normalized_windows(self):
        snap = snapshot(
            "openai-codex",
            title="Codex limits",
            plan="ChatGPT Plus",
            windows=[{"label": "5-hour", "used_percent": 30.0},
                     {"label": "Weekly", "used_percent": 60.0}],
            details=("Credits balance: $5.00",),
        )
        with mock.patch("agent.account_usage.fetch_account_usage", return_value=snap):
            row = backend._fetch_codex()
        self.assert_ui_contract(row)
        self.assertEqual([window["label"] for window in row["limits"][0]["windows"]],
                         ["5-hour", "Weekly"])
        self.assertEqual(row["details"], ["Credits balance: $5.00"])
        self.assertTrue(row["available"])

    def test_provider_failure_is_a_safe_error(self):
        with mock.patch("agent.account_usage.fetch_account_usage", return_value=None):
            row = backend._fetch_codex()
        self.assertFalse(row["available"])
        self.assertTrue("usage is unavailable" in row["unavailable_reason"]
                        or "not configured" in row["unavailable_reason"])
        self.assertNotIn(SECRET, json.dumps(row))

    def test_old_core_is_an_upgrade_row_not_a_typeerror(self):
        with mock.patch.object(backend, "_core_seam_available", return_value=False):
            row = backend._fetch_codex()
        self.assertFalse(row["available"])
        self.assertIn("does not expose the read-only provider-usage snapshot API",
                      row["unavailable_reason"])


class AnthropicParityTests(ParityCase):
    def test_snapshot_keeps_model_scoped_windows_and_extra_usage(self):
        snap = snapshot(
            "anthropic",
            source="oauth_usage_api",
            windows=[
                {"label": "Current session", "used_percent": 25.0, "reset_at": now()},
                {"label": "Current week", "used_percent": 50.0},
                {"label": "Opus week", "used_percent": 80.0, "scope": "model"},
                {"label": "Sonnet week", "used_percent": 5.0, "scope": "model"},
            ],
            details=("Extra usage: 3.00 / 30.00 USD",),
        )
        with mock.patch("agent.account_usage.fetch_account_usage", return_value=snap):
            row = backend._fetch_provider("anthropic")
        self.assert_ui_contract(row)
        self.assertEqual([window["label"] for window in row["limits"][0]["windows"]],
                         ["Current session", "Current week", "Opus week", "Sonnet week"])
        self.assertEqual(row["details"], ["Extra usage: 3.00 / 30.00 USD"])
        self.assertEqual(row["capability"], "usage")
        self.assertTrue(row["available"])

    def test_unavailable_snapshot_reason_is_preserved(self):
        snap = snapshot(
            "anthropic",
            windows=(),
            details=(),
            unavailable_reason="Anthropic account limits are only available for OAuth-backed Claude accounts.",
        )
        with mock.patch("agent.account_usage.fetch_account_usage", return_value=snap):
            row = backend._fetch_provider("anthropic")
        self.assertIn("OAuth-backed", row["unavailable_reason"])
        self.assertFalse(row["available"])


class OpenRouterParityTests(ParityCase):
    @staticmethod
    def _snap(credits=None, key=None):
        return snapshot(
            "openrouter", source="credits_api",
            raw={"credits": copy.deepcopy(credits or OPENROUTER_CREDITS),
                 "key": copy.deepcopy(key if key is not None else OPENROUTER_KEY)},
        )

    def test_credits_key_quota_free_quota_and_key_usage(self):
        with mock_core_usage({"openrouter": self._snap()}):
            row = backend._fetch_openrouter()
        self.assert_ui_contract(row)
        self.assertEqual(row["balances"], [{
            "label": "Credits remaining", "amount": 12.5, "currency": "USD",
            "total": 100.0, "used": 87.5,
        }])
        self.assertEqual([group["id"] for group in row["limits"]], ["key", "default"])
        self.assertEqual(row["limits"][0]["windows"][0]["used_percent"], 75.0)
        self.assertIn("$12.50 of $50.00 remaining", row["limits"][0]["windows"][0]["detail"])
        self.assertEqual(row["limits"][1]["windows"][0]["label"], "Free model requests")
        self.assertEqual(row["limits"][1]["windows"][0]["used_percent"], 75.0)
        self.assertIn("250 of 1,000 requests remaining today",
                      row["limits"][1]["windows"][0]["detail"])
        self.assertEqual(row["key_usage"], {
            "total": 87.5, "daily": 1.25, "weekly": 9.5, "monthly": 40.0, "byok_total": 4.0,
        })
        self.assertEqual(row["capability"], "balance")
        self.assertTrue(row["available"])

    def test_credits_only_response_still_reports_a_balance(self):
        with mock_core_usage({"openrouter": self._snap(key={})}):
            row = backend._fetch_openrouter()
        self.assert_ui_contract(row)
        self.assertEqual(row["balances"][0]["amount"], 12.5)
        self.assertEqual(row["limits"], [])
        self.assertIsNone(row["key_usage"])

    def test_core_snapshot_without_raw_keeps_normalized_snapshot(self):
        snap = snapshot(
            "openrouter", source="credits_api",
            windows=[{"label": "API key quota", "used_percent": 75.0}],
            details=("Credits balance: $12.50",), raw=None,
        )
        with mock_core_usage({"openrouter": snap}), \
                mock.patch.object(backend, "_direct_openrouter", return_value=None):
            row = backend._fetch_openrouter()
        self.assert_ui_contract(row)
        self.assertTrue(row["available"])
        self.assertEqual(row["details"], ["Credits balance: $12.50"])
        self.assertEqual(row["limits"][0]["windows"][0]["used_percent"], 75.0)
        self.assertEqual(row["balances"], [])
        self.assertIsNone(row["key_usage"])

    def test_old_core_without_the_seam_reports_upgrade_not_a_raw_fallback(self):
        with mock.patch.object(backend, "_core_seam_available", return_value=False):
            row = backend._fetch_openrouter()
        self.assertFalse(row["available"])
        self.assertIn("does not expose the read-only provider-usage snapshot API",
                      row["unavailable_reason"])
        self.assertIn("no raw-credential fallback", row["unavailable_reason"])


class DeepSeekParityTests(ParityCase):
    @staticmethod
    def _snap(payload):
        return snapshot("deepseek", source="user_balance_api",
                        raw={"balance": copy.deepcopy(payload)})

    def test_multi_currency_balances_keep_components_and_currency(self):
        with mock_core_usage({"deepseek": self._snap(DEEPSEEK_BALANCE)}):
            row = backend._fetch_deepseek()
        self.assert_ui_contract(row)
        self.assertEqual(row["balances"], [
            {"label": "Total balance", "amount": 12.34, "currency": "USD",
             "granted": 2.0, "topped_up": 10.34},
            {"label": "Total balance", "amount": 88.0, "currency": "CNY"},
        ])
        self.assertEqual(row["source"], "user_balance_api")
        self.assertTrue(row["available"])
        self.assertIsNone(row["unavailable_reason"])

    def test_unavailable_account_keeps_the_reason(self):
        payload = {"is_available": False, "balance_infos": []}
        with mock_core_usage({"deepseek": self._snap(payload)}):
            row = backend._fetch_deepseek()
        self.assert_ui_contract(row)
        self.assertEqual(row["details"], ["Account available: no"])
        self.assertFalse(row["available"])
        self.assertIn("no balance entries", row["unavailable_reason"])


class OpenCodeGoParityTests(ParityCase):
    def test_snapshot_windows_and_both_products(self):
        snap = snapshot(
            "opencode-go",
            source="go_usage_api",
            windows=[
                {"label": "rolling", "used_percent": 40.0, "reset_at": now()},
                {"label": "Weekly", "used_percent": 20.0},
                {"label": "Monthly", "used_percent": 10.0},
            ],
        )
        with mock_core_usage({"opencode-go": snap}):
            row = backend._fetch_opencode_go()
        self.assert_ui_contract(row)
        self.assertEqual([window["label"] for window in row["limits"][0]["windows"]],
                         ["5-hour", "Weekly", "Monthly"])
        self.assertTrue(row["limits"][0]["allowed"])
        self.assertFalse(row["limits"][0]["limit_reached"])
        self.assertEqual([product["id"] for product in row["products"]], ["go", "zen"])
        self.assertEqual(row["products"][0]["limits"], row["limits"])
        self.assertTrue(row["products"][0]["available"])
        self.assertFalse(row["products"][1]["available"])
        self.assertIn("Zen wallet balance", row["products"][1]["unavailable_reason"])
        self.assertIn("Allowance ceilings", row["products"][0]["details"][0])
        self.assertEqual(row["plan"], "Go subscription")
        self.assertTrue(row["available"])

    def test_raw_usage_body_keeps_rolling_label(self):
        usage = {"usage": {
            "rolling": {"percent": 55.0, "resetsAt": "2026-11-11T20:00:00Z"},
            "weekly": {"percent": 20.0, "resetsAt": "2026-11-17T00:00:00Z"},
        }}
        snap = snapshot("opencode-go", source="go_usage_api", raw=copy.deepcopy(usage))
        with mock_core_usage({"opencode-go": snap}):
            row = backend._fetch_opencode_go()
        self.assert_ui_contract(row)
        self.assertEqual([window["label"] for window in row["limits"][0]["windows"]],
                         ["5-hour", "Weekly"])
        self.assertEqual(row["limits"][0]["windows"][0]["used_percent"], 55.0)
        self.assertEqual(row["source"], "go_usage_api")


class OpenCodeZenParityTests(ParityCase):
    def test_authenticated_models_route_reports_access_without_a_wallet(self):
        snap = snapshot("opencode-zen", source="models_api", plan="Zen API credits",
                        raw={"models": {"data": [{"id": "synthetic-model"}]}})
        with mock_core_usage({"opencode-zen": snap}):
            row = backend._fetch_opencode_zen()
        self.assert_ui_contract(row)
        self.assertTrue(row["available"])
        self.assertEqual(row["products"][0]["id"], "zen")
        self.assertIn("not exposed through OpenCode API keys", row["details"][0])
        self.assertEqual(row["source"], "models_api")


class OllamaCloudParityTests(ParityCase):
    @staticmethod
    def _snap(balance=None):
        return snapshot("ollama-cloud", source="usage_api",
                        raw={"usage": copy.deepcopy(OLLAMA_USAGE),
                             "balance": copy.deepcopy(balance or {})})

    def test_usage_windows_models_activity_and_totals(self):
        with mock_core_usage({"ollama-cloud": self._snap()}):
            row = backend._fetch_ollama_cloud()
        self.assert_ui_contract(row)
        self.assertEqual([window["label"] for window in row["limits"][0]["windows"]],
                         ["5-hour", "Weekly", "Monthly"])
        self.assertEqual([window["used_percent"] for window in row["limits"][0]["windows"]],
                         [40.0, 55.0, 100.0])
        self.assertFalse(row["limits"][0]["allowed"])
        self.assertTrue(row["limits"][0]["limit_reached"])
        self.assertIn("gpt-oss:120b: 12 requests", row["details"])
        self.assertIn("Spend in the monthly: $0.42", row["details"])
        self.assertEqual(row["activity"]["range"], "7d")
        self.assertEqual(row["activity"]["requests"], 1200)
        self.assertEqual(row["activity"]["usd"], 3.5)
        self.assertEqual(row["activity"]["input_tokens"], 1_000_000)
        self.assertEqual(row["activity"]["cached_tokens"], 250_000)
        self.assertEqual(row["activity"]["output_tokens"], 500_000)
        self.assertEqual(row["activity"]["hit_rate"], 0.25)
        self.assertEqual(row["activity"]["buckets"],
                         [{"from": "2026-11-10", "usd": 0.5, "requests": 100}])
        self.assertIn("Reset times are not published", row["details"][-1])

    def test_balance_adds_monthly_allowance_and_purchased_credits_first(self):
        with mock_core_usage({"ollama-cloud": self._snap(OLLAMA_BALANCE)}):
            row = backend._fetch_ollama_cloud()
        self.assert_ui_contract(row)
        windows = row["limits"][0]["windows"]
        self.assertEqual([window["label"] for window in windows],
                         ["Monthly included", "5-hour", "Weekly", "Monthly"])
        credit = windows[0]
        self.assertEqual(credit["used_percent"], 75.0)
        self.assertEqual(credit["spent_usd"], 15.0)
        self.assertEqual(credit["remaining_usd"], 5.0)
        self.assertEqual(credit["allowance_usd"], 20.0)
        self.assertEqual(credit["reset_at"], "2026-12-01T00:00:00Z")
        self.assertEqual(row["balances"],
                         [{"label": "Purchased credits", "amount": 2.5, "currency": "USD"}])
        self.assertFalse(any("Reset times are not published" in str(item) for item in row["details"]))
        self.assertTrue(row["available"])


class XaiParityTests(ParityCase):
    def test_proxy_keeps_plan_period_prepaid_and_product_split(self):
        with mock_xai_broker([("/v1/billing", copy.deepcopy(GROK_PROXY)),
                              ("/v1/settings", copy.deepcopy(GROK_SETTINGS))]):
            row = backend._fetch_xai()
        self.assert_ui_contract(row)
        self.assertEqual(row["plan"], "SuperGrok Heavy")
        self.assertEqual(row["limits"][0]["label"], "SuperGrok Heavy")
        self.assertEqual(row["limits"][0]["windows"][0]["label"], "Weekly")
        self.assertEqual(row["limits"][0]["windows"][0]["used_percent"], 62.5)
        self.assertEqual([item["id"] for item in row["breakdown"]], ["GrokImagine", "GrokChat"])
        self.assertEqual([item["used_percent"] for item in row["breakdown"]], [32.5, 30.0])
        self.assertIn("Shares of this week's pool", row["breakdown_note"])
        self.assertEqual(row["balances"],
                         [{"label": "Prepaid credits", "amount": 15.0, "currency": "USD"}])
        self.assertIn("On-demand top-up uses a saved payment method.", row["details"])
        self.assertIn("One shared pool across Grok products.", row["details"])
        self.assertEqual(row["source"], "grok_cli_proxy")

    def test_unreconciled_product_split_is_dropped_not_shown(self):
        payload = copy.deepcopy(GROK_PROXY)
        payload["config"]["productUsage"] = [
            {"product": "GrokChat", "usagePercent": 30.0},
            {"product": "GrokImagine", "usagePercent": 20.0},
        ]
        with mock_xai_broker([("/v1/billing", payload),
                              ("/v1/settings", copy.deepcopy(GROK_SETTINGS))]):
            row = backend._fetch_xai()
        self.assertEqual(row["breakdown"], [])
        self.assertIsNone(row["breakdown_note"])

    def test_grpc_fallback_keeps_window_and_pay_as_you_go_balance(self):
        def varint(value):
            out = bytearray()
            while True:
                byte = value & 0x7F
                value >>= 7
                if value:
                    out.append(byte | 0x80)
                else:
                    out.append(byte)
                    return bytes(out)

        def tag(field, wire):
            return varint((field << 3) | wire)

        def length_delimited(field, payload):
            return tag(field, 2) + varint(len(payload)) + payload

        def cent(value):
            # ``_cent`` reads field 1 as a bare varint inside the money message.
            return tag(1, 0) + varint(value)

        def timestamp(seconds):
            return tag(1, 0) + varint(seconds) + tag(2, 0) + varint(0)

        config = (
            tag(1, 5) + struct.pack("<f", 75.0)
            + length_delimited(2, cent(5000))
            + length_delimited(3, cent(1250))
            + length_delimited(5, timestamp(1800000000))
        )
        message = length_delimited(1, config)
        frame = b"\x00" + len(message).to_bytes(4, "big") + message

        with mock.patch.object(backend, "_fetch_xai_proxy", side_effect=RuntimeError("synthetic")), \
                mock_xai_broker([("/v1/settings", copy.deepcopy(GROK_SETTINGS)),
                                 ("GetGrokCreditsConfig", frame)]):
            row = backend._fetch_xai()
        self.assert_ui_contract(row)
        window = row["limits"][0]["windows"][0]
        self.assertEqual(window["label"], "Subscription credits")
        self.assertEqual(window["used_percent"], 75.0)
        self.assertEqual(window["reset_at"], "2027-01-15T08:00:00Z")
        self.assertEqual(row["balances"], [{
            "label": "Pay-as-you-go remaining", "amount": 37.5, "currency": "USD",
            "total": 50.0, "used": 12.5,
        }])
        self.assertIn("Product breakdown is not on this fallback", row["details"][0])
        self.assertEqual(row["source"], "grok_billing_grpc")
        self.assertEqual(row["plan"], "SuperGrok Heavy")


class NousParityTests(ParityCase):
    def _account(self, **overrides):
        from hermes_cli.nous_account import (
            NousPaidServiceAccessInfo, NousPortalAccountInfo, NousPortalSubscriptionInfo,
        )

        values = {
            "logged_in": True,
            "source": "account_api",
            "fresh": True,
            "portal_base_url": "https://portal.example.test",
            "subscription": NousPortalSubscriptionInfo(
                plan="Nous Pro",
                monthly_credits=100.0,
                credits_remaining=40.0,
                rollover_credits=5.0,
                current_period_end="2026-12-01",
            ),
            "paid_service_access": True,
            "paid_service_access_info": NousPaidServiceAccessInfo(
                subscription_credits_remaining=35.0,
                purchased_credits_remaining=5.0,
                total_usable_credits=40.0,
            ),
        }
        values.update(overrides)
        return NousPortalAccountInfo(**values)

    def _snapshot(self, **overrides):
        from agent.account_usage import build_nous_credits_snapshot

        built = build_nous_credits_snapshot(self._account(**overrides))
        self.assertIsNotNone(built, "core built no Nous snapshot for the synthetic account")
        return built

    def test_gauge_account_keeps_percent_details_plan_and_topup_link(self):
        with mock_core_usage({"nous": self._snapshot()}):
            row = backend._fetch_nous()
        self.assert_ui_contract(row)
        self.assertEqual(row["plan"], "Nous Pro")
        self.assertEqual(row["limits"][0]["windows"][0]["label"], "Subscription")
        self.assertEqual(row["limits"][0]["windows"][0]["used_percent"], 60.0)
        details = " | ".join(row["details"])
        self.assertIn("Subscription credits:", details)
        self.assertIn("Top-up credits:", details)
        self.assertIn("Total usable:", details)
        self.assertIn("Rollover:", details)
        self.assertIn("Renews: 2026-12-01", details)
        self.assertIn("https://portal.example.test/billing?topup=open", details)
        self.assertTrue(row["available"])

    def test_depleted_account_keeps_the_depleted_line(self):
        from agent.account_usage import build_nous_credits_snapshot
        from hermes_cli.nous_account import NousPortalAccountInfo

        account = NousPortalAccountInfo(
            logged_in=True, source="account_api", fresh=True,
            portal_base_url="https://portal.example.test", paid_service_access=False,
        )
        snap = build_nous_credits_snapshot(account)
        self.assertIsNotNone(snap)
        with mock_core_usage({"nous": snap}):
            row = backend._fetch_nous()
        self.assert_ui_contract(row)
        self.assertEqual(row["limits"], [])
        self.assertTrue(any("depleted" in str(item).lower() for item in row["details"]), row["details"])
        self.assertTrue(row["available"])


# ---------------------------------------------------------------------------
# Inventory, profile selection, overview
# ---------------------------------------------------------------------------

def inventory_config():
    return {
        "model": {"provider": "openai-codex", "default": "gpt-5.2-codex"},
        "fallback_providers": [{"provider": "openrouter"}],
        "auxiliary": {"provider": "anthropic"},
        "custom_providers": [{"name": "my-local", "provider": "custom"}],
    }


class InventoryParityTests(ParityCase):
    def _inventory(self, *, credentials=(), config=None):
        with mock.patch("hermes_cli.config.load_config", return_value=config or inventory_config()), \
                mock.patch.object(backend, "_has_local_credentials",
                                  side_effect=lambda provider: provider in set(credentials)):
            return backend._inventory()

    def test_config_and_env_only_providers_appear_with_labels_and_capability(self):
        rows = self._inventory(credentials={"deepseek", "ollama-cloud", "opencode-go"})
        ids = [row["id"] for row in rows]
        self.assertEqual(ids, [
            "openai-codex", "openrouter", "anthropic", "custom:my-local",
            "deepseek", "ollama-cloud", "opencode-go",
        ])
        by_id = {row["id"]: row for row in rows}
        self.assertEqual(by_id["openai-codex"]["capability"], "usage")
        self.assertEqual(by_id["openrouter"]["capability"], "balance")
        self.assertEqual(by_id["custom:my-local"]["capability"], "unsupported")
        self.assertEqual(by_id["custom:my-local"]["label"], "my-local")
        self.assertFalse(by_id["custom:my-local"]["supported"])
        self.assertTrue(by_id["ollama-cloud"]["supported"])
        for row in rows:
            self.assertNotIn(SECRET, json.dumps(row))

    def test_alias_and_unknown_providers_are_canonicalized(self):
        config = {"model": {"provider": "grok-oauth"}, "custom_providers": [{"name": "azure-local"}]}
        rows = self._inventory(config=config)
        self.assertEqual([row["id"] for row in rows], ["xai-oauth", "custom:azure-local"])
        self.assertEqual(rows[0]["label"], "SuperGrok / xAI OAuth")

    def test_profile_value_cleaning(self):
        self.assertIsNone(backend._clean_profile(None))
        self.assertIsNone(backend._clean_profile(""))
        self.assertIsNone(backend._clean_profile("current"))
        self.assertIsNone(backend._clean_profile("ACTIVE"))
        self.assertEqual(backend._clean_profile(" beta "), "beta")

    @unittest.skipIf(STOCK_CORE, "enhanced core provides provider_credential_summary")
    def test_inventory_presence_comes_from_the_public_summary(self):
        def summary(provider):
            if provider == "deepseek":
                return {"provider": provider, "configured": True, "account_count": 2,
                        "source": "pool", "profile_scope": "home:0123456789abcdef"}
            return {"provider": provider, "configured": False, "account_count": 0,
                    "source": "none", "profile_scope": "home:0123456789abcdef"}

        with mock.patch("hermes_cli.config.load_config", return_value={}), \
                mock.patch("agent.account_usage.provider_credential_summary",
                           side_effect=summary):
            rows = backend._inventory()
            self.assertTrue(backend._has_local_credentials("deepseek"))
            self.assertFalse(backend._has_local_credentials("openrouter"))
        self.assertEqual([row["id"] for row in rows], ["deepseek"])

    @unittest.skipIf(STOCK_CORE, "enhanced core provides list_account_usage_identities")
    def test_account_rows_dedupe_and_stay_bounded(self):
        entries = [
            {"identity_id": "fp:aaaaaaaaaaaaaaaa", "label": "A"},
            {"identity_id": "fp:aaaaaaaaaaaaaaaa", "label": "A duplicate"},
            {"identity_id": "fp:bbbbbbbbbbbbbbbb", "label": "B"},
        ] + [{"identity_id": f"fp:{index:016x}", "label": f"X{index}"}
             for index in range(20)]
        with mock.patch("agent.account_usage.list_account_usage_identities",
                        return_value=entries):
            accounts = backend._account_identities("openrouter")
        self.assertEqual(len(accounts), backend._ACCOUNT_USAGE_MAX_ACCOUNTS)
        self.assertEqual(len({entry["identity_id"] for entry in accounts}), len(accounts))
        self.assertEqual(accounts[0], {"identity_id": "fp:aaaaaaaaaaaaaaaa", "label": "A"})


class AccountAttributionParityTests(ParityCase):
    """Overview ``row.accounts[]``: exact identities, no borrowed pool."""

    ID_A = "fp:aaaaaaaaaaaaaaaa"
    ID_B = "fp:bbbbbbbbbbbbbbbb"

    @staticmethod
    def _row(provider="openrouter", amount=1.0):
        row = backend._base(provider, title="Provider", source="credits_api")
        row["available"] = True
        row["balances"] = [{"label": "Credits", "amount": amount, "currency": "USD"}]
        return row

    def test_single_account_reuses_the_provider_row_when_its_identity_is_verified(self):
        row = self._row()
        row["identity_id"] = self.ID_A
        row["account_id"] = self.ID_A
        with mock.patch.object(backend, "_account_identities", return_value=[
            {"identity_id": self.ID_A, "label": "Account A"},
        ]), mock.patch.object(backend, "_account_usage_row",
                              side_effect=AssertionError("a verified match must not re-read")):
            row = backend._attach_accounts("openrouter", row)
        self.assertEqual(row["identity_id"], self.ID_A)
        self.assertEqual(row["account_label"], "Account A")
        self.assertEqual(row["accounts"][0]["identity_id"], self.ID_A)
        self.assertEqual(row["accounts"][0]["balances"], row["balances"])

    def _exact_usage(self, provider, amount):
        exact = self._row(provider, amount=amount)
        exact["identity_id"] = self.ID_A
        exact["account_id"] = self.ID_A
        return exact

    def test_codex_single_account_never_inherits_an_unverified_provider_wide_row(self):
        """An env/singleton provider-wide fetch is not proof of the sole pool account."""
        with mock.patch.object(backend, "_account_identities", return_value=[
            {"identity_id": self.ID_A, "label": "Codex A"},
        ]), mock.patch.object(backend, "_account_usage_row",
                              side_effect=lambda provider, identity_id: self._exact_usage(provider, 7.0)) as read:
            row = backend._attach_accounts("openai-codex", self._row("openai-codex", amount=99.0))

        self.assertNotIn("identity_id", row)
        self.assertNotIn("account_label", row)
        entry = row["accounts"][0]
        self.assertEqual(entry["identity_id"], self.ID_A)
        self.assertEqual(entry["balances"][0]["amount"], 7.0)
        self.assertEqual([call.args for call in read.call_args_list],
                         [("openai-codex", self.ID_A)])

    def test_anthropic_single_account_never_inherits_an_unverified_provider_wide_row(self):
        with mock.patch.object(backend, "_account_identities", return_value=[
            {"identity_id": self.ID_A, "label": "Claude A"},
        ]), mock.patch.object(backend, "_account_usage_row",
                              side_effect=lambda provider, identity_id: self._exact_usage(provider, 3.0)) as read:
            row = backend._attach_accounts("anthropic", self._row("anthropic", amount=99.0))

        self.assertNotIn("identity_id", row)
        self.assertNotIn("account_label", row)
        entry = row["accounts"][0]
        self.assertEqual(entry["identity_id"], self.ID_A)
        self.assertEqual(entry["balances"][0]["amount"], 3.0)
        self.assertEqual([call.args for call in read.call_args_list],
                         [("anthropic", self.ID_A)])

    def test_xai_single_account_stays_unknown_without_a_verified_identity(self):
        """xAI has no per-identity fetch, so an unverified provider-wide row stays unknown."""
        with mock.patch.object(backend, "_account_identities", return_value=[
            {"identity_id": self.ID_A, "label": "Grok A"},
        ]), mock.patch.object(backend, "_account_usage_row",
                              side_effect=AssertionError("xAI has no exact identity fetch")):
            row = backend._attach_accounts("xai-oauth", self._row("xai-oauth", amount=99.0))

        self.assertNotIn("identity_id", row)
        self.assertNotIn("account_label", row)
        entry = row["accounts"][0]
        self.assertEqual(entry["identity_id"], self.ID_A)
        self.assertNotIn("balances", entry)
        self.assertNotIn("limits", entry)

    def test_multi_account_entries_get_only_their_own_usage(self):
        def usage(provider, identity_id):
            amount = 10.0 if identity_id == self.ID_A else 20.0
            exact = self._row(amount=amount)
            exact["identity_id"] = identity_id
            exact["account_id"] = identity_id
            return exact

        with mock.patch.object(backend, "_account_identities", return_value=[
            {"identity_id": self.ID_A, "label": "Account A"},
            {"identity_id": self.ID_B, "label": "Account B"},
        ]), mock.patch.object(backend, "_account_usage_row",
                              side_effect=usage) as read:
            row = backend._attach_accounts("openrouter", self._row(amount=99.0))

        self.assertNotIn("identity_id", row)
        entries = {entry["identity_id"]: entry for entry in row["accounts"]}
        self.assertEqual(entries[self.ID_A]["balances"][0]["amount"], 10.0)
        self.assertEqual(entries[self.ID_B]["balances"][0]["amount"], 20.0)
        # The provider-wide value is never copied onto an account entry.
        self.assertNotIn(99.0, [entry["balances"][0]["amount"] for entry in row["accounts"]])
        self.assertEqual([call.args for call in read.call_args_list],
                         [("openrouter", self.ID_A), ("openrouter", self.ID_B)])

    def test_nous_is_never_fetched_per_identity(self):
        with mock.patch.object(backend, "_account_identities", return_value=[
            {"identity_id": self.ID_A, "label": "A"},
            {"identity_id": self.ID_B, "label": "B"},
        ]), mock.patch.object(backend, "_account_usage_row",
                              side_effect=AssertionError("Nous credits are account-global")):
            row = backend._attach_accounts("nous", self._row("nous", amount=5.0))
        self.assertEqual(len(row["accounts"]), 2)
        self.assertNotIn("limits", row["accounts"][0])

    def test_exact_identity_missing_never_falls_back_to_provider_usage(self):
        calls = []

        def fake_fetch(provider, **kwargs):
            calls.append((provider, kwargs))
            return None

        with mock.patch("agent.account_usage.fetch_account_usage", side_effect=fake_fetch):
            first = backend._account_usage_row("openrouter", self.ID_A)
            second = backend._account_usage_row("openrouter", self.ID_A)
        self.assertIsNone(first)
        self.assertIsNone(second)
        self.assertEqual(calls, [
            ("openrouter", {"read_only": True, "identity_id": self.ID_A}),
        ], "a missing identity must be a negative cache entry, never a provider-wide read")

    def test_exact_identity_read_rejects_a_missing_or_different_snapshot_identity(self):
        def fetch_with(identity):
            def fake_fetch(provider, **kwargs):
                return snapshot("openrouter", identity=identity, source="credits_api", raw={
                    "credits": {"total_credits": 10.0, "total_usage": 1.0}, "key": {},
                })
            return fake_fetch

        backend._clear_account_caches()
        with mock.patch("agent.account_usage.fetch_account_usage",
                        side_effect=fetch_with(None)):
            self.assertIsNone(backend._account_usage_row("openrouter", self.ID_A))

        backend._clear_account_caches()
        with mock.patch("agent.account_usage.fetch_account_usage",
                        side_effect=fetch_with(self.ID_B)):
            self.assertIsNone(backend._account_usage_row("openrouter", self.ID_A),
                              "a different account's figures must never attach to the requested id")

        backend._clear_account_caches()
        with mock.patch("agent.account_usage.fetch_account_usage",
                        side_effect=fetch_with(self.ID_A)):
            row = backend._account_usage_row("openrouter", self.ID_A)
        self.assertIsNotNone(row)
        self.assertEqual(row["identity_id"], self.ID_A)

    def test_stamp_snapshot_maps_stock_identity_to_the_identity_id(self):
        row = backend._serialize_snapshot(snapshot(
            "openrouter", identity=self.ID_A, source="credits_api",
            raw={"credits": {"total_credits": 10.0, "total_usage": 1.0}, "key": {}},
        ))
        self.assertEqual(row.get("identity_id"), self.ID_A)

    def test_attach_accounts_never_assigns_usage_from_an_unproven_identity(self):
        def fake_usage(provider, identity_id):
            unproven = self._row(amount=7.0)
            unproven["identity_id"] = self.ID_B
            return unproven

        with mock.patch.object(backend, "_account_identities", return_value=[
            {"identity_id": self.ID_A, "label": "Account A"},
        ]), mock.patch.object(backend, "_account_usage_row", side_effect=fake_usage):
            row = backend._attach_accounts("openrouter", self._row(amount=99.0))

        entry = row["accounts"][0]
        self.assertEqual(entry["identity_id"], self.ID_A)
        self.assertNotIn("limits", entry)
        self.assertNotIn("balances", entry)
        self.assertNotIn("fetched_at", entry)
        self.assertNotIn("identity_id", row)

    def test_account_usage_cache_dedupes_expires_and_stays_bounded(self):
        calls = []

        def snap_for(identity):
            return snapshot("openrouter", identity=identity, source="credits_api", raw={
                "credits": {"total_credits": 10.0, "total_usage": 1.0}, "key": {},
            })

        def fake_fetch(provider, **kwargs):
            identity = kwargs.get("identity_id")
            calls.append((provider, identity))
            return snap_for(identity)

        with mock.patch("agent.account_usage.fetch_account_usage", side_effect=fake_fetch):
            with mock.patch.object(backend, "_ACCOUNT_USAGE_TTL_SECS", 60.0):
                backend._account_usage_row("openrouter", self.ID_A)
                backend._account_usage_row("openrouter", self.ID_A)
            self.assertEqual(len(calls), 1)
            with mock.patch.object(backend, "_ACCOUNT_USAGE_TTL_SECS", 0.0):
                backend._account_usage_row("openrouter", self.ID_A)
            self.assertEqual(len(calls), 2)
            for index in range(backend._ACCOUNT_USAGE_MAX_ENTRIES + 5):
                backend._account_usage_row("openrouter", f"fp:{index:016x}")
        self.assertLessEqual(len(backend._ACCOUNT_USAGE_CACHE),
                             backend._ACCOUNT_USAGE_MAX_ENTRIES)


class OverviewParityTests(ParityCase):
    DEFINITION_PAYLOADS = {
        "github-rate-limit": {
            "resources": {
                "core": {"limit": 60, "used": 1, "remaining": 59, "reset": 1800000000},
                "search": {"limit": 10, "used": 2, "remaining": 8, "reset": 1800000000},
                "graphql": {"limit": 0, "used": 0, "remaining": 0, "reset": 1800000000},
            }
        },
        "moonshot-balance": {
            "data": {"available_balance": 12.5, "voucher_balance": 2.0, "cash_balance": 10.5},
            "status": "ok",
            "scode": "0",
        },
        "elevenlabs-subscription": {
            "tier": "creator",
            "character_count": 100,
            "character_limit": 1000,
            "next_character_count_reset_unix": 1800000000,
            "status": "active",
            "character_refresh_period": "monthly",
            "voice_slots_used": 2,
            "voice_limit": 10,
        },
    }

    def test_overview_keeps_rows_errors_unsupported_and_catalog(self):
        codex = backend._base("openai-codex", title="Codex limits", source="usage_api")
        codex["limits"] = [{"id": "default", "label": "Codex", "windows": [
            backend._window("5-hour", 10.0)]}]
        codex["available"] = True

        def fetch(provider, **_kwargs):
            if provider == "openai-codex":
                return codex
            raise RuntimeError("synthetic provider failure")

        def declarative(definition, **_kwargs):
            payload = self.DEFINITION_PAYLOADS[definition["id"]]
            return backend._normalize_definition_row(
                definition, payload, fetched_at=backend._now(), cache="hit", profile=None)

        with mock.patch("hermes_cli.config.load_config", return_value=inventory_config()), \
                mock.patch("agent.secret_scope.get_secret", return_value=None), \
                mock.patch.object(backend, "_has_local_credentials", return_value=False), \
                mock.patch.object(backend, "_account_identities", return_value=[]), \
                mock.patch.object(backend, "_maybe_refresh_vendor_specs"), \
                mock.patch.object(backend, "_pricing_rows", return_value=[]), \
                mock.patch.object(backend, "_fetch_provider", side_effect=fetch), \
                mock.patch.object(backend, "_fetch_declarative_cached", side_effect=declarative):
            data = backend._overview_scoped({}, None)

        self.assertEqual(data["version"], 1)
        ids = [row["id"] for row in data["providers"]]
        self.assertEqual(ids, [
            "openai-codex", "openrouter", "anthropic", "custom:my-local",
            "github-rate-limit",
        ])
        by_id = {row["id"]: row for row in data["providers"]}
        self.assertTrue(by_id["openai-codex"]["available"])
        # A failed provider becomes a safe, non-secret unavailable row.
        self.assertFalse(by_id["openrouter"]["available"])
        self.assertEqual(by_id["openrouter"]["unavailable_reason"],
                         "RuntimeError while reading provider data.")
        self.assertEqual(by_id["custom:my-local"]["capability"], "unsupported")
        # Declarative rows keep their real mapped values through the overview.
        github_windows = by_id["github-rate-limit"]["limits"][0]["windows"]
        self.assertEqual([window["label"] for window in github_windows],
                         ["Core", "Search", "GraphQL"])
        self.assertEqual(github_windows[0]["used_percent"], 1.67)
        self.assertIsNone(github_windows[2]["used_percent"])
        self.assertEqual(github_windows[2]["detail"], "No allowance reported")
        # Definitions whose env var is missing stay in the catalog as
        # "available to connect" and are NOT fetched or listed as providers.
        self.assertNotIn("moonshot-balance", by_id)
        self.assertNotIn("elevenlabs-subscription", by_id)
        self.assertEqual(data["active"]["provider"], "openai-codex")
        self.assertEqual(data["account_profile"], "default")
        self.assertEqual({item["id"]: item["state"] for item in data["catalog"]["definitions"]},
                         {"github-rate-limit": "connected", "moonshot-balance": "available",
                          "elevenlabs-subscription": "available"})
        self.assertNotIn(SECRET, json.dumps(data))


class CatalogTrustParityTests(ParityCase):
    def test_bundled_catalog_states_and_setup_metadata(self):
        with mock.patch("agent.secret_scope.get_secret", return_value=None):
            catalog = backend.definitions_catalog()
        by_id = {entry["id"]: entry for entry in catalog["definitions"]}
        self.assertEqual(set(by_id), {"github-rate-limit", "moonshot-balance",
                                      "elevenlabs-subscription"})
        self.assertEqual(by_id["github-rate-limit"]["state"], "ready")
        self.assertEqual(by_id["github-rate-limit"]["trust"], "approved")
        self.assertFalse(by_id["github-rate-limit"]["approval_required"])
        self.assertEqual(by_id["github-rate-limit"]["credential_refs"], [])
        for ident, env_name in (("moonshot-balance", "MOONSHOT_API_KEY"),
                                ("elevenlabs-subscription", "ELEVENLABS_API_KEY")):
            entry = by_id[ident]
            self.assertEqual(entry["state"], "available")
            self.assertEqual(entry["credential_refs"], [{"source": "env", "name": env_name}])
            self.assertEqual(entry["missing_credentials"], [env_name])
            self.assertEqual(entry["setup"]["env"], [env_name])
            self.assertIn("approve_definition.py", entry["setup"]["approve"])
            self.assertTrue(entry["scope"].startswith("home:"))
            self.assertFalse(any("value" in ref for ref in entry["credential_refs"]))
        self.assertEqual(catalog["bundled_count"], 3)
        self.assertEqual(catalog["profile_count"], 0)

    def test_profile_definition_needs_approval_and_reads_no_secret(self):
        raw = json.loads((ROOT / "dashboard" / "definitions" / "catalog" /
                          "moonshot-balance.json").read_text(encoding="utf-8"))
        raw["id"] = "local-balance"
        raw["request"] = dict(raw["request"], url="https://api.moonshot.ai/v1/other")
        (self.defs / "local-balance.json").write_text(json.dumps(raw), encoding="utf-8")
        with mock.patch("agent.secret_scope.get_secret", return_value=None):
            loaded = backend._load_provider_definitions()
            prepared = backend._prepare_definitions(loaded)
            catalog = backend.definitions_catalog()
        # No header (and therefore no credential) is resolved for the untrusted
        # definition; only approved definitions get their references resolved.
        self.assertEqual(prepared["local-balance"]["trust"], "untrusted")
        self.assertEqual(prepared["local-balance"]["headers"], {})
        self.assertEqual(prepared["local-balance"]["missing"], [])
        self.assertEqual(prepared["moonshot-balance"]["missing"], ["MOONSHOT_API_KEY"])
        entry = {item["id"]: item for item in catalog["definitions"]}["local-balance"]
        self.assertEqual(entry["state"], "requires_approval")
        self.assertEqual(entry["trust"], "untrusted")
        self.assertTrue(entry["approval_required"])
        self.assertEqual(entry["credential_refs"], [{"source": "env", "name": "MOONSHOT_API_KEY"}])

    def test_definition_mapping_keeps_typed_window_balances_and_details(self):
        loaded = backend._load_provider_definitions()
        definition = loaded["valid"]["moonshot-balance"]["definition"]
        row = backend._normalize_definition_row(
            definition,
            {"data": {"available_balance": 12.5, "voucher_balance": 2.0, "cash_balance": 10.5},
             "status": "ok", "scode": "0"},
            fetched_at=backend._now(), cache="miss", profile="default",
        )
        self.assert_ui_contract(row)
        self.assertEqual(row["capability"], "balance")
        self.assertEqual([(item["label"], item["amount"], item["currency"], item["kind"])
                          for item in row["balances"]], [
            ("Available balance", 12.5, "USD", "credit"),
            ("Voucher balance", 2.0, "USD", "grant"),
            ("Cash balance", 10.5, "USD", "wallet"),
        ])
        self.assertIn("Request status: ok", row["details"])
        self.assertTrue(row["available"])


class RatesAndDerivedParityTests(ParityCase):
    """Rate cards / peak / cache are derived, not fetched per adapter.

    They must keep working independently of how a provider body is fetched, so
    these assertions pin the derived surfaces the pane renders.
    """

    def test_peak_schedule_is_derived_from_published_spec_without_a_request(self):
        with mock.patch.object(backend, "_load_vendor_cache", return_value={}):
            peak = backend._peak_state(
                "deepseek", at=datetime(2026, 11, 11, 2, 0, tzinfo=timezone.utc))
            none = backend._peak_state("openrouter")
        self.assertEqual(none, None)
        self.assertEqual(peak["mode"], "peak")
        self.assertEqual(peak["multiplier"], 2.0)
        self.assertIn("Peak 2×", peak["schedule"])
        self.assertEqual(peak["source_url"], "https://api-docs.deepseek.com/quick_start/pricing")
        self.assertTrue(peak["upcoming"])
        self.assertTrue(peak["windows_local"])

    def test_cache_stats_are_absent_without_a_ledger(self):
        self.assertEqual(backend._cache_stats(), {})


# ---------------------------------------------------------------------------
# Credential hygiene
# ---------------------------------------------------------------------------

class CredentialHygieneTests(ParityCase):
    def test_error_copy_never_echoes_urls_tokens_or_headers(self):
        request = httpx.Request("GET", f"https://api.example.test/v1/usage?key={SECRET}")
        status_error = httpx.HTTPStatusError(
            "synthetic", request=request, response=httpx.Response(401, request=request))
        self.assertEqual(backend._safe_request_error(status_error), "Provider returned HTTP 401.")
        self.assertEqual(backend._safe_request_error(httpx.ConnectError("synthetic")),
                         "Provider request failed.")
        self.assertEqual(backend._safe_request_error(httpx.ReadTimeout("synthetic")),
                         "Provider request timed out.")
        self.assertEqual(backend._safe_request_error(KeyError("synthetic")),
                         "KeyError while reading provider data.")
        for exc in (status_error, httpx.ConnectError("synthetic"), KeyError("synthetic")):
            self.assertNotIn(SECRET, backend._safe_request_error(exc))

    def test_adapter_rows_never_include_the_runtime_key(self):
        snapshots = {
            "openrouter": snapshot("openrouter", source="credits_api", raw={
                "credits": copy.deepcopy(OPENROUTER_CREDITS),
                "key": copy.deepcopy(OPENROUTER_KEY),
            }),
            "deepseek": snapshot("deepseek", source="user_balance_api",
                                 raw={"balance": copy.deepcopy(DEEPSEEK_BALANCE)}),
            "ollama-cloud": snapshot("ollama-cloud", source="usage_api", raw={
                "usage": copy.deepcopy(OLLAMA_USAGE), "balance": {},
            }),
            "opencode-zen": snapshot("opencode-zen", source="models_api",
                                     raw={"models": {"data": []}}),
        }
        with mock_core_usage(snapshots):
            self.assert_clean(backend._fetch_openrouter())
            self.assert_clean(backend._fetch_deepseek())
            self.assert_clean(backend._fetch_ollama_cloud())
            self.assert_clean(backend._fetch_opencode_zen())
        with mock_xai_broker([("/v1/billing", copy.deepcopy(GROK_PROXY)),
                              ("/v1/settings", copy.deepcopy(GROK_SETTINGS))]):
            self.assert_clean(backend._fetch_xai())


# ---------------------------------------------------------------------------
# Current narrowing probes (green today; update when a core seam lands)
# ---------------------------------------------------------------------------

class CurrentNarrowingProbes(ParityCase):
    """Quantifies what a naive migration would lose.  Update, do not delete.

    Each probe names the core seam that closes it in
    ``docs/credential-migration-parity.md``.
    """

    def test_core_openrouter_snapshot_route_drops_money_and_key_detail(self):
        # Exactly the shape core's ``_fetch_openrouter_account_usage`` returns:
        # money becomes one detail string, only the key-quota window survives.
        snap = snapshot(
            "openrouter",
            source="credits_api",
            windows=[{"label": "API key quota", "used_percent": 75.0,
                      "detail": "$12.50 of $50.00 remaining • resets monthly"}],
            details=("Credits balance: $12.50",
                     "API key usage: $87.50 total • $1.25 today • $9.50 this week • $40.00 this month"),
            raw=None,
        )
        row = backend._serialize_snapshot(snap)
        self.assert_ui_contract(row)
        self.assertEqual(row["balances"], [])
        self.assertIsNone(row["key_usage"])
        self.assertEqual(len(row["limits"]), 1)
        self.assertEqual([window["label"] for window in row["limits"][0]["windows"]],
                         ["API key quota"])
        self.assertFalse(any(group["label"] == "Free models" for group in row["limits"]))

    @unittest.skipIf(STOCK_CORE, "stock core has no identity_id snapshot field")
    def test_snapshot_serializer_preserves_account_identity_and_window_scope(self):
        snap = snapshot(
            "openai-codex",
            windows=[{"label": "Opus week", "used_percent": 80.0, "scope": "model"}],
            identity="codex:synthetic-account:synthetic-subject",
            identity_id="codex:synthetic-account:synthetic-subject",
            account_id="codex:synthetic-account:synthetic-subject",
            profile_scope="home:0123456789abcdef",
        )
        row = backend._serialize_snapshot(snap)
        self.assertEqual(row["identity_id"], "codex:synthetic-account:synthetic-subject")
        self.assertEqual(row["account_id"], "codex:synthetic-account:synthetic-subject")
        self.assertEqual(row["profile_scope"], "home:0123456789abcdef")
        # The raw decoded ``identity`` claim is not republished; only the
        # namespaced, non-secret correlation id is.
        self.assertNotIn("identity", row)
        self.assertNotIn("account", row)
        self.assertEqual(row["limits"][0]["windows"][0]["scope"], "model")

    def test_inventory_is_one_row_per_provider_while_overview_adds_accounts(self):
        with mock.patch("hermes_cli.config.load_config", return_value={}), \
                mock.patch.object(backend, "_has_local_credentials", return_value=True):
            rows = backend._inventory()
        self.assertEqual(len(rows), len(backend._SUPPORTED))
        codex_rows = [row for row in rows if row["id"] == "openai-codex"]
        self.assertEqual(len(codex_rows), 1)
        self.assertNotIn("accounts", codex_rows[0])
        self.assertNotIn("identities", codex_rows[0])
        with mock.patch.object(backend, "_account_identities", return_value=[{
            "identity_id": "codex:synthetic-account:synthetic-subject",
            "label": "Synthetic Codex",
            "available": True,
            "status": "ok",
        }]), mock.patch.object(backend, "_account_usage_row",
                              side_effect=AssertionError("a verified row must not re-read")):
            enriched = backend._attach_accounts("openai-codex", {
                **codex_rows[0], "available": True,
                "identity_id": "codex:synthetic-account:synthetic-subject",
                "limits": [{"id": "default", "label": "Codex", "windows": [
                    backend._window("5-hour", 10.0)]}],
                "balances": [],
            })
        self.assertEqual(enriched["identity_id"], "codex:synthetic-account:synthetic-subject")
        self.assertEqual(enriched["accounts"][0]["identity_id"],
                         "codex:synthetic-account:synthetic-subject")
        self.assertEqual(enriched["accounts"][0]["limits"], enriched["limits"])



# ---------------------------------------------------------------------------
# Living guards (green today, tighten when the migration lands)
# ---------------------------------------------------------------------------

class LivingGuardTests(ParityCase):
    def test_read_only_is_requested_wherever_core_supports_it(self):
        import agent.account_usage as core_usage

        supported = set(getattr(core_usage, "_READ_ONLY_USAGE_FETCHERS", {}) or {})
        calls = []

        def fake_fetch(provider, **kwargs):
            calls.append((provider, kwargs))
            return snapshot(provider, windows=[{"label": "Synthetic", "used_percent": 1.0}])

        with mock.patch("agent.account_usage.fetch_account_usage", side_effect=fake_fetch):
            for provider in ("openai-codex", "anthropic", "opencode-go"):
                if provider not in supported:
                    continue
                backend._fetch_provider(provider)
        for provider, kwargs in calls:
            if provider in supported:
                self.assertTrue(kwargs.get("read_only") is True,
                                f"{provider} must ask core for a read-only snapshot")

    def test_manifest_declares_any_secret_name_the_code_reads(self):
        source = BACKEND_PATH.read_text(encoding="utf-8")
        manifest = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
        # Names the code resolves as literals (not names mentioned in comments or
        # carried by a definition).  Declarative references are declared by the
        # definition itself and already covered by the catalog tests.
        literal_secrets = set(re.findall(
            r"get_secret\(\s*[\"']([A-Z][A-Z0-9_]+)[\"']", source))
        for name in sorted(literal_secrets):
            self.assertIn(name, manifest,
                          f"{name} is read from the secret scope but not declared in plugin.yaml")
        if "credentialed_provider_request" in source:
            self.assertRegex(manifest, r"(?m)^requires_auth:")
            self.assertIn("openai-codex", manifest)


# ---------------------------------------------------------------------------
# Future acceptance (opt-in: HERMES_PU_ACCEPT_MIGRATION=1)
# ---------------------------------------------------------------------------

def _acceptance_routes():
    """Path suffix -> payload for every endpoint a migrated adapter may need."""
    return [
        ("/api/v1/credits", {"data": copy.deepcopy(OPENROUTER_CREDITS)}),
        ("/api/v1/key", {"data": copy.deepcopy(OPENROUTER_KEY)}),
        ("/user/balance", copy.deepcopy(DEEPSEEK_BALANCE)),
        ("/api/balance", copy.deepcopy(OLLAMA_BALANCE)),
        ("/api/usage", copy.deepcopy(OLLAMA_USAGE)),
        ("/zen/go/v1/usage", {"usage": {"rolling": {"percent": 55.0}, "weekly": {"percent": 20.0}}}),
        ("/v1/settings", copy.deepcopy(GROK_SETTINGS)),
        ("/v1/billing", copy.deepcopy(GROK_PROXY)),
        ("/models", {"data": [{"id": "synthetic-model"}]}),
    ]


PARITY_SIGNATURES = {
    "openai-codex": lambda row: (
        bool(row["limits"]) and row["credit_status"] is not None
        and row["reset_credits"] is not None and row["model_access"] and row["spend_control"]),
    "anthropic": lambda row: len(row["limits"][0]["windows"]) == 4 and bool(row["details"]),
    "openrouter": lambda row: (
        row["balances"] and row["balances"][0].get("total") is not None
        and row["balances"][0].get("used") is not None
        and (row["key_usage"] or {}).get("daily") is not None
        and any(group["label"] == "Free models" for group in row["limits"])),
    "deepseek": lambda row: {item["currency"] for item in row["balances"]} == {"USD", "CNY"},
    "xai-oauth": lambda row: bool(row["breakdown"]) and row["plan"] == "SuperGrok Heavy",
    "opencode-go": lambda row: len(row["products"]) == 2,
    "opencode-zen": lambda row: bool(row["products"]) and bool(row["details"]),
    "ollama-cloud": lambda row: bool(row["activity"]) and bool(row["balances"]),
    "nous": lambda row: row["plan"] == "Nous Pro" and bool(row["details"]),
}


def _core_snapshots():
    return {
        "openai-codex": snapshot("openai-codex", raw=copy.deepcopy(CODEX_RAW)),
        "anthropic": snapshot("anthropic", windows=[
            {"label": "Current session", "used_percent": 25.0},
            {"label": "Current week", "used_percent": 50.0},
            {"label": "Opus week", "used_percent": 80.0},
            {"label": "Sonnet week", "used_percent": 5.0},
        ], details=("Extra usage: 3.00 / 30.00 USD",)),
        "opencode-go": snapshot("opencode-go", windows=[
            {"label": "rolling", "used_percent": 40.0},
            {"label": "weekly", "used_percent": 20.0},
            {"label": "monthly", "used_percent": 10.0},
        ], raw={"usage": {
            "rolling": {"percent": 40.0},
            "weekly": {"percent": 20.0},
            "monthly": {"percent": 10.0},
        }}),
        "nous": snapshot("nous", plan="Nous Pro", details=("Subscription credits: $35.00",)),
        "openrouter": snapshot(
            "openrouter", source="credits_api",
            windows=[{"label": "API key quota", "used_percent": 75.0}],
            details=("Credits balance: $12.50",),
            raw={"credits": copy.deepcopy(OPENROUTER_CREDITS),
                 "key": copy.deepcopy(OPENROUTER_KEY)}),
        "deepseek": snapshot(
            "deepseek", source="user_balance_api",
            raw={"balance": copy.deepcopy(DEEPSEEK_BALANCE)}),
        "ollama-cloud": snapshot(
            "ollama-cloud", source="usage_api",
            raw={"usage": copy.deepcopy(OLLAMA_USAGE),
                 "balance": copy.deepcopy(OLLAMA_BALANCE)}),
        "opencode-zen": snapshot(
            "opencode-zen", source="models_api", plan="Zen API credits",
            raw={"models": {"data": [{"id": "synthetic-model"}]}}),
    }


@unittest.skipUnless(MIGRATION_ACCEPTANCE,
                     "future migration acceptance; set HERMES_PU_ACCEPT_MIGRATION=1")
class MigrationAcceptanceTests(ParityCase):
    def _nous_account(self):
        from hermes_cli.nous_account import NousPortalAccountInfo, NousPortalSubscriptionInfo

        return NousPortalAccountInfo(
            logged_in=True, source="account_api", fresh=True,
            portal_base_url="https://portal.example.test",
            subscription=NousPortalSubscriptionInfo(
                plan="Nous Pro", monthly_credits=100.0, credits_remaining=40.0),
        )

    def test_every_builtin_provider_parity_survives_without_a_raw_runtime_key(self):
        snapshots = _core_snapshots()
        calls = []

        def fake_fetch(provider, **kwargs):
            calls.append((provider, kwargs))
            return snapshots.get(provider)

        def fake_broker(provider, method, url, **kwargs):
            from hermes_cli.plugin_provider_requests import ProviderResponse

            path = httpx.URL(url).path
            for suffix, payload in _acceptance_routes():
                if path.endswith(suffix):
                    body = json.dumps(payload).encode()
                    return ProviderResponse(status=200,
                                            headers={"content-type": "application/json"},
                                            body=body)
            raise AssertionError(f"migration called an unexpected endpoint: {path}")

        forbidden = (
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            "agent.credential_pool.load_pool",
            "hermes_cli.auth.get_provider_auth_state",
        )
        managers = [
            mock.patch("agent.account_usage.fetch_account_usage", side_effect=fake_fetch),
            mock.patch("hermes_cli.plugin_provider_requests.credentialed_provider_request",
                       side_effect=fake_broker),
            mock.patch("agent.secret_scope.get_secret", return_value=SECRET),
            mock.patch("hermes_cli.nous_account.get_nous_portal_account_info",
                       return_value=self._nous_account()),
        ]
        managers += [mock.patch(target, side_effect=AssertionError(
            f"migration must not call {target}")) for target in forbidden]
        for manager in managers:
            manager.start()
            self.addCleanup(manager.stop)

        manager = mock_http(_acceptance_routes())
        manager.__enter__()
        self.addCleanup(manager.__exit__, None, None, None)

        failures = {}
        for provider in sorted(backend._SUPPORTED):
            try:
                row = backend._fetch_provider(provider)
            except Exception as exc:  # report every blocker, not just the first
                failures[provider] = f"{type(exc).__name__}: {exc}"
                continue
            self.assert_ui_contract(row)
            self.assertTrue(row["available"], f"{provider} row is not available after migration")
            self.assertTrue(PARITY_SIGNATURES[provider](row),
                            f"{provider} lost a parity field set: "
                            f"{json.dumps({key: row[key] for key in ('balances', 'limits', 'details', 'products', 'key_usage', 'breakdown', 'activity')}, default=str)[:800]}")
        self.assertEqual(failures, {},
                         "adapters still resolve credentials outside the sanctioned routes: "
                         + json.dumps(failures, indent=2))
        snapshot_providers = {provider for provider, _ in calls}
        read_only = {provider for provider, kwargs in calls if kwargs.get("read_only") is True}
        self.assertTrue(snapshot_providers <= read_only,
                        "every snapshot adapter must ask core for a read-only read: "
                        + ", ".join(sorted(snapshot_providers - read_only)))

    def test_no_credential_store_or_private_auth_imports_remain(self):
        source = BACKEND_PATH.read_text(encoding="utf-8")
        forbidden = {
            "resolve_runtime_provider": "raw runtime key resolver",
            "credential_pool": "credential pool store",
            "get_provider_auth_state": "raw auth store",
            "hermes_cli.nous_account": "private Nous account module",
        }
        found = {token: reason for token, reason in forbidden.items() if token in source}
        self.assertEqual(found, {}, "credential access still bypasses the sanctioned routes")

    def test_core_snapshot_route_preserves_openrouter_details(self):
        row = backend._serialize_snapshot(_core_snapshots()["openrouter"])
        self.assert_ui_contract(row)
        self.assertEqual(row["balances"][0]["total"], 100.0)
        self.assertEqual(row["balances"][0]["used"], 87.5)
        self.assertEqual(row["balances"][0]["amount"], 12.5)
        self.assertEqual(row["key_usage"], {
            "total": 87.5, "daily": 1.25, "weekly": 9.5, "monthly": 40.0, "byok_total": 4.0,
        })
        self.assertEqual([group["label"] for group in row["limits"]],
                         ["API key quota", "Free models"])
        self.assertEqual(row["limits"][1]["windows"][0]["detail"],
                         "250 of 1,000 requests remaining today")

    def test_pool_only_accounts_surface_after_migration(self):
        # Real core helpers: write two OpenRouter pool entries, then let the
        # plugin's overview list them and fetch each identity's usage through
        # the public `fetch_account_usage(..., identity_id=...)` route. Only the
        # network transport is synthetic.
        auth = {
            "credential_pool": {
                "openrouter": [
                    {
                        "id": "acct-a", "label": "OpenRouter A", "auth_type": "api_key",
                        "priority": 0, "source": "manual",
                        "access_token": "sk-or-synthetic-account-a",
                        "base_url": "https://openrouter.ai/api/v1",
                    },
                    {
                        "id": "acct-b", "label": "OpenRouter B", "auth_type": "api_key",
                        "priority": 1, "source": "manual",
                        "access_token": "sk-or-synthetic-account-b",
                        "base_url": "https://openrouter.ai/api/v1",
                    },
                ]
            }
        }
        (self.home / "auth.json").write_text(json.dumps(auth), encoding="utf-8")

        def transport(request):
            token = str(request.headers.get("authorization") or "")
            total, used = (100.0, 25.0) if token.endswith("-a") else (40.0, 10.0)
            if request.url.path.endswith("/credits"):
                return json_response({"data": {"total_credits": total, "total_usage": used}},
                                     request=request)
            if request.url.path.endswith("/key"):
                return json_response({"data": {
                    "usage": used, "usage_daily": 1.0,
                    "free_model_daily_requests": {"limit": 1000, "remaining": 900},
                }}, request=request)
            return httpx.Response(404, json={}, request=request)

        real_identities = backend._account_identities

        def identities(provider):
            return real_identities(provider) if provider == "openrouter" else []

        row = backend._base("openrouter", title="OpenRouter credits", source="credits_api")
        row["available"] = True
        row["balances"] = [{"label": "Credits", "amount": 75.0, "currency": "USD"}]

        def provider_row(provider):
            return backend._base(provider, title="Provider", source="credits_api")

        with mock.patch("hermes_cli.config.load_config", return_value=inventory_config()), \
                mock.patch.object(backend, "_has_local_credentials",
                                  side_effect=lambda provider: provider == "openrouter"), \
                mock.patch.object(backend, "_account_identities", side_effect=identities), \
                mock.patch.object(backend, "_fetch_provider",
                                  side_effect=lambda provider: copy.deepcopy(row)
                                  if provider == "openrouter" else provider_row(provider)), \
                mock.patch.object(backend, "_maybe_refresh_vendor_specs"), \
                mock.patch.object(backend, "_pricing_rows", return_value=[]), \
                mock_http(handler=transport):
            data = backend._overview_scoped({}, None)

        openrouter = {item["id"]: item for item in data["providers"]}["openrouter"]
        accounts = openrouter["accounts"]
        self.assertEqual(len(accounts), 2)
        identities_seen = {entry["identity_id"] for entry in accounts}
        self.assertEqual(len(identities_seen), 2)
        self.assertTrue(all(identity.startswith("fp:") for identity in identities_seen))
        self.assertEqual({entry["label"] for entry in accounts},
                         {"OpenRouter A", "OpenRouter B"})
        # Each entry carries its OWN balance, never the provider-wide row.
        by_label = {entry["label"]: entry for entry in accounts}
        self.assertEqual(by_label["OpenRouter A"]["balances"][0]["total"], 100.0)
        self.assertEqual(by_label["OpenRouter B"]["balances"][0]["total"], 40.0)
        # A multi-account provider row must not claim one account's identity.
        self.assertNotIn("identity_id", openrouter)


@unittest.skipUnless(MIGRATION_ACCEPTANCE,
                     "future migration acceptance; set HERMES_PU_ACCEPT_MIGRATION=1")
class CoreSeamAcceptanceTests(unittest.TestCase):
    """Core-side seams this migration depends on, owned by the core checkout."""

    def test_every_supported_provider_has_a_sanctioned_public_route(self):
        # Rule 11 is per-route, not a universal broker. API-key providers use
        # the public read-only account-usage fetchers; xAI is the one brokered
        # subscription route; Nous is a public read-only snapshot too.
        import agent.account_usage as core_usage

        public_reads = set(core_usage._READ_ONLY_USAGE_FETCHERS)
        public_reads |= set(getattr(core_usage, "_USAGE_FALLBACK_FETCHERS", {}) or {})
        brokered = {"xai-oauth"}
        missing = sorted(set(backend._SUPPORTED) - public_reads - brokered)
        self.assertEqual(missing, [],
                         "no sanctioned public route for: " + ", ".join(missing))
        self.assertIn("nous", public_reads,
                      "Nous must be readable without importing hermes_cli.nous_account")

    def test_core_builtin_fetchers_all_have_a_read_only_variant(self):
        import agent.account_usage as core_usage

        builtin = set(core_usage._USAGE_FETCHERS)
        read_only = set(core_usage._READ_ONLY_USAGE_FETCHERS)
        self.assertEqual(sorted(builtin - read_only), [],
                         "fetch_account_usage(read_only=True) is unsupported for these "
                         "core-built-in providers")


INSTALLED_ROUTE_SCRIPT = r'''
import importlib.util
import json
import os
import sys
from pathlib import Path
from unittest import mock

import httpx

HOME = Path(os.environ["HERMES_HOME"])
PLUGIN = Path(os.environ["HERMES_PU_PLUGIN"])
from agent.account_usage import fetch_account_usage, list_account_usage_identities

spec = importlib.util.spec_from_file_location(
    "provider_usage_installed", PLUGIN / "dashboard" / "plugin_api.py")
backend = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = backend
spec.loader.exec_module(backend)

def handler(request):
    token = str(request.headers.get("authorization") or "")
    total, used = (100.0, 25.0) if token.endswith("-a") else (40.0, 10.0)
    if request.url.path.endswith("/credits"):
        return httpx.Response(200, json={"data": {
            "total_credits": total, "total_usage": used}})
    if request.url.path.endswith("/key"):
        return httpx.Response(200, json={"data": {
            "usage": used, "usage_daily": 1.0,
            "free_model_daily_requests": {"limit": 1000, "remaining": 900}}})
    return httpx.Response(404, json={})

identities = list_account_usage_identities("openrouter")
ids = [entry["identity_id"] for entry in identities]
real_client = httpx.Client
def factory(*args, **kwargs):
    kwargs["transport"] = httpx.MockTransport(handler)
    return real_client(*args, **kwargs)
httpx.Client = factory
snapshots = {}
for identity in ids:
    snap = fetch_account_usage("openrouter", read_only=True, identity_id=identity)
    snapshots[identity] = {
        "raw_total": snap.raw["credits"]["total_credits"],
        "identity": snap.identity_id,
    }

with mock.patch("hermes_cli.config.load_config",
                return_value={"model": {"provider": "openrouter"}}), \
        mock.patch.object(backend, "_maybe_refresh_vendor_specs"), \
        mock.patch.object(backend, "_pricing_rows", return_value=[]):
    data = backend._overview_scoped({}, None)
rows = [row for row in data["providers"] if row["id"] == "openrouter"]
row = rows[0]
print(json.dumps({
    "plugin_file": str(PLUGIN / "dashboard" / "plugin_api.py"),
    "identities": ids,
    "snapshots": snapshots,
    "accounts": [
        {"identity_id": entry["identity_id"], "label": entry["label"],
         "balance_total": entry["balances"][0]["total"],
         "limits": len(entry.get("limits") or [])}
        for entry in row["accounts"]
    ],
    "provider_wide_balance": row["balances"][0]["amount"],
    "flat_identity": row.get("identity_id"),
}, sort_keys=True))
'''


@unittest.skipUnless(MIGRATION_ACCEPTANCE,
                     "future migration acceptance; set HERMES_PU_ACCEPT_MIGRATION=1")
class InstalledFixtureRouteTests(unittest.TestCase):
    """Installed-plugin fixture + the real core account helpers (transport only mocked)."""

    def test_overview_accounts_use_the_installed_plugin_and_real_core(self):
        source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            plugin = home / "plugins" / "jg-provider-usage"
            plugin.mkdir(parents=True)
            shutil.copytree(source / "dashboard", plugin / "dashboard",
                            ignore=shutil.ignore_patterns("__pycache__"))
            shutil.copy2(source / "plugin.yaml", plugin / "plugin.yaml")
            (home / "auth.json").write_text(json.dumps({"credential_pool": {
                "openrouter": [
                    {"id": "acct-a", "label": "OpenRouter A", "auth_type": "api_key",
                     "priority": 0, "source": "manual",
                     "access_token": "sk-or-synthetic-account-a",
                     "base_url": "https://openrouter.ai/api/v1"},
                    {"id": "acct-b", "label": "OpenRouter B", "auth_type": "api_key",
                     "priority": 1, "source": "manual",
                     "access_token": "sk-or-synthetic-account-b",
                     "base_url": "https://openrouter.ai/api/v1"},
                ]
            }}), encoding="utf-8")

            script = home / "call_installed_route.py"
            script.write_text(INSTALLED_ROUTE_SCRIPT, encoding="utf-8")
            env = os.environ.copy()
            env["HERMES_HOME"] = str(home)
            env["HERMES_PU_PLUGIN"] = str(plugin)
            env["PYTHONPATH"] = str(Path(os.environ.get(
                "HERMES_PU_CORE_CHECKOUT",
                r"C:/Users/jerry/AppData/Local/hermes/worktrees/provider-usage-core-seams")))
            env.pop("HERMES_PU_ACCEPT_MIGRATION", None)
            completed = subprocess.run(
                [sys.executable, str(script)], cwd=str(home), env=env,
                capture_output=True, text=True, timeout=120,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload = json.loads(completed.stdout.strip().splitlines()[-1])

        self.assertTrue(Path(payload["plugin_file"]).is_relative_to(plugin))
        self.assertEqual(len(payload["identities"]), 2)
        self.assertTrue(all(item.startswith("fp:") for item in payload["identities"]))
        self.assertEqual({entry["balance_total"] for entry in payload["accounts"]},
                         {100.0, 40.0})
        self.assertEqual({entry["label"] for entry in payload["accounts"]},
                         {"OpenRouter A", "OpenRouter B"})
        self.assertEqual(payload["provider_wide_balance"], 75.0)
        self.assertIsNone(payload["flat_identity"])
        for entry in payload["accounts"]:
            self.assertEqual(payload["snapshots"][entry["identity_id"]]["raw_total"],
                             entry["balance_total"])


if __name__ == "__main__":
    unittest.main()
