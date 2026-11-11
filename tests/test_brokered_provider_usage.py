"""Brokered Grok usage tests: the plugin never resolves or holds the xAI grant.

Two layers:

* Synthetic plugin tests drive the real ``_fetch_xai`` normalizer with a fake
  ``credentialed_provider_request``.  They pin every data field the Desktop pane
  consumes for both routes (credits proxy and gRPC-web fallback), prove the
  fallback still happens for non-auth failures, and prove 401/403, permission
  refusals and a pre-broker core never fall back to a raw token.
* ``RealBrokerCoreCheckoutTests`` invokes the real core helper from an isolated
  core checkout (``HERMES_PU_CORE_CHECKOUT``, default
  ``worktrees/xai-plugin-provider-requests``) inside an installed-plugin fixture
  under a throwaway ``HERMES_HOME``.  It uses a synthetic in-process bearer and a
  mock HTTP transport only: no real credential, no network, no token in a
  response body.
"""

import base64
import contextlib
import importlib.util
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

import httpx

ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = ROOT / "dashboard" / "plugin_api.py"
DEFAULT_CORE_CHECKOUT = Path(
    r"C:\Users\jerry\AppData\Local\hermes\worktrees\xai-plugin-provider-requests"
)

SECRET = "«redacted:synthetic-grok-token»"


def load_backend():
    module_name = "provider_usage_plugin_api_brokered"
    spec = importlib.util.spec_from_file_location(module_name, BACKEND_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


backend = load_backend()

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


def grpc_frame() -> bytes:
    """A minimal GetGrokCreditsConfig frame: 75% used, $50 cap, $12.50 used."""
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
    return b"\x00" + len(message).to_bytes(4, "big") + message


def provider_response(payload=None, *, status=200, body=None, headers=None):
    from hermes_cli.plugin_provider_requests import ProviderResponse

    if body is None:
        body = json.dumps(payload if payload is not None else {}).encode()
    return ProviderResponse(status=status, headers=dict(headers or {}), body=body)


@contextlib.contextmanager
def fake_broker(routes):
    """Route broker calls by path suffix; record what the plugin handed over."""
    calls = []

    def fake(provider, method, url, **kwargs):
        from hermes_cli.plugin_provider_requests import ProviderResponse

        calls.append({
            "provider": provider,
            "method": method,
            "url": url,
            "headers": dict(kwargs.get("headers") or {}),
            "content": kwargs.get("content"),
        })
        path = httpx.URL(url).path
        for suffix, answer in routes:
            if path.endswith(suffix):
                if isinstance(answer, Exception):
                    raise answer
                if isinstance(answer, ProviderResponse):
                    return answer
                if isinstance(answer, bytes):
                    return provider_response(body=answer,
                                             headers={"content-type": "application/grpc-web+proto"})
                return provider_response(answer)
        return provider_response(status=404)

    with mock.patch("hermes_cli.plugin_provider_requests.credentialed_provider_request",
                    side_effect=fake):
        yield calls


class XaiBrokerMigrationTests(unittest.TestCase):
    def test_proxy_keeps_every_field_and_sends_no_authorization(self):
        with fake_broker([
            ("/v1/billing", GROK_PROXY),
            ("/v1/settings", GROK_SETTINGS),
        ]) as calls:
            row = backend._fetch_xai()

        self.assertTrue(row["available"])
        self.assertEqual(row["source"], "grok_cli_proxy")
        self.assertEqual(row["plan"], "SuperGrok Heavy")
        self.assertEqual(row["limits"], [{
            "id": "supergrok", "label": "SuperGrok Heavy", "windows": [{
                "label": "Weekly", "used_percent": 62.5, "remaining_percent": 37.5,
                "reset_at": "2026-11-18T00:00:00Z", "detail": None,
            }],
        }])
        self.assertEqual(row["breakdown"], [
            {"id": "GrokImagine", "label": "Imagine", "used_percent": 32.5},
            {"id": "GrokChat", "label": "Chat", "used_percent": 30.0},
        ])
        self.assertIn("Shares of this week's pool", row["breakdown_note"])
        self.assertEqual(row["balances"],
                         [{"label": "Prepaid credits", "amount": 15.0, "currency": "USD"}])
        self.assertEqual(row["details"], [
            "On-demand top-up uses a saved payment method.",
            "One shared pool across Grok products.",
        ])
        self.assertEqual([call["method"] for call in calls], ["GET", "GET"])
        self.assertEqual([httpx.URL(call["url"]).path for call in calls],
                         ["/v1/billing", "/v1/settings"])
        for call in calls:
            headers = {name.lower(): value for name, value in call["headers"].items()}
            self.assertNotIn("authorization", headers)
            self.assertEqual(headers["x-xai-token-auth"], "xai-grok-cli")
            self.assertTrue(headers["user-agent"].startswith("hermes-provider-usage/"))
        self.assertNotIn(SECRET, json.dumps(row))

    def test_grpc_fallback_keeps_every_field_and_raw_bytes(self):
        frame = grpc_frame()
        with fake_broker([
            ("/v1/billing", provider_response(status=503)),
            ("GetGrokCreditsConfig", frame),
            ("/v1/settings", GROK_SETTINGS),
        ]) as calls:
            row = backend._fetch_xai()

        self.assertTrue(row["available"])
        self.assertEqual(row["source"], "grok_billing_grpc")
        self.assertEqual(row["plan"], "SuperGrok Heavy")
        self.assertEqual(row["limits"][0]["windows"][0], {
            "label": "Subscription credits", "used_percent": 75.0,
            "remaining_percent": 25.0, "reset_at": "2027-01-15T08:00:00Z", "detail": None,
        })
        self.assertEqual(row["balances"], [{
            "label": "Pay-as-you-go remaining", "amount": 37.5, "currency": "USD",
            "total": 50.0, "used": 12.5,
        }])
        self.assertIn("Product breakdown is not on this fallback", row["details"][0])

        posts = [call for call in calls if call["method"] == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["url"],
                         "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig")
        self.assertEqual(posts[0]["content"], b"\x00\x00\x00\x00\x00")
        headers = {name.lower(): value for name, value in posts[0]["headers"].items()}
        self.assertEqual(headers["content-type"], "application/grpc-web+proto")
        self.assertNotIn("authorization", headers)

    def test_proxy_auth_status_does_not_fall_back(self):
        with fake_broker([("/v1/billing", provider_response(status=401))]) as calls:
            row = backend._fetch_xai()
        self.assertFalse(row["available"])
        self.assertIn("HTTP 401", row["unavailable_reason"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["method"], "GET")

    def test_grpc_auth_status_does_not_fall_back_or_retry(self):
        with fake_broker([
            ("/v1/billing", provider_response(status=500)),
            ("GetGrokCreditsConfig", provider_response(status=403)),
        ]) as calls:
            row = backend._fetch_xai()
        self.assertFalse(row["available"])
        self.assertIn("HTTP 403", row["unavailable_reason"])
        self.assertEqual([call["method"] for call in calls], ["GET", "POST"])

    def test_permission_refusal_is_not_a_fallback(self):
        with fake_broker([("/v1/billing", PermissionError("refused by policy"))]) as calls:
            row = backend._fetch_xai()
        self.assertFalse(row["available"])
        self.assertIn("refused by policy", row["unavailable_reason"])
        self.assertEqual(len(calls), 1)

    def test_pre_broker_core_reports_upgrade_and_never_reads_a_raw_token(self):
        with mock.patch("hermes_cli.runtime_provider.resolve_runtime_provider",
                        side_effect=AssertionError("raw runtime must not be read")), \
                mock.patch("hermes_cli.plugin_provider_requests.credentialed_provider_request",
                           side_effect=ValueError(
                               "No signed-in requests for provider 'xai-oauth' (supported: openai-codex)")):
            row = backend._fetch_xai()
        self.assertFalse(row["available"])
        self.assertIn("does not broker xAI", row["unavailable_reason"])
        self.assertIn("never reads the raw OAuth token", row["unavailable_reason"])

    def test_legacy_helper_signature_reports_upgrade_without_bytes_argument(self):
        calls = []

        def legacy(provider, method, url, *, headers=None, timeout=30.0):
            calls.append((provider, method, url))
            raise ValueError("No signed-in requests for provider 'xai-oauth'")

        with mock.patch("hermes_cli.plugin_provider_requests.credentialed_provider_request",
                        new=legacy):
            row = backend._fetch_xai()
            with self.assertRaises(backend._XaiBrokerUnavailable):
                backend._credentialed_xai_request(
                    "POST", backend._GROK_BILLING_GRPC, content=b"\x00\x00\x00\x00\x00")

        self.assertFalse(row["available"])
        self.assertIn("does not broker xAI", row["unavailable_reason"])
        self.assertEqual(len(calls), 1)  # the proxy GET never passed content=

    def test_missing_broker_module_reports_upgrade(self):
        with mock.patch.dict(sys.modules, {"hermes_cli.plugin_provider_requests": None}):
            row = backend._fetch_xai()
        self.assertFalse(row["available"])
        self.assertIn("does not broker xAI", row["unavailable_reason"])
        self.assertNotIn(SECRET, json.dumps(row))


class OpenRouterRawSnapshotTests(unittest.TestCase):
    def test_raw_snapshot_rebuilds_money_key_usage_and_free_quota(self):
        from agent.account_usage import AccountUsageSnapshot

        snapshot = AccountUsageSnapshot(
            provider="openrouter", source="credits_api", fetched_at=datetime.now(UTC),
            raw={
                "credits": {"total_credits": 100.0, "total_usage": 87.5},
                "key": {
                    "limit": 50.0,
                    "limit_remaining": 12.5,
                    "limit_reset": "monthly",
                    "usage": 87.5,
                    "usage_daily": 1.25,
                    "usage_weekly": 9.5,
                    "usage_monthly": 40.0,
                    "byok_usage": 4.0,
                    "free_model_daily_requests": {"limit": 1000, "remaining": 250},
                },
            },
        )
        row = backend._serialize_snapshot(snapshot)

        self.assertEqual(row["balances"], [{
            "label": "Credits remaining", "amount": 12.5, "currency": "USD",
            "total": 100.0, "used": 87.5,
        }])
        self.assertEqual([group["id"] for group in row["limits"]], ["key", "default"])
        self.assertEqual(row["limits"][0]["windows"][0]["used_percent"], 75.0)
        self.assertEqual(row["limits"][1]["windows"][0]["label"], "Free model requests")
        self.assertEqual(row["limits"][1]["windows"][0]["used_percent"], 75.0)
        self.assertIn("250 of 1,000 requests remaining today",
                      row["limits"][1]["windows"][0]["detail"])
        self.assertEqual(row["key_usage"], {
            "total": 87.5, "daily": 1.25, "weekly": 9.5, "monthly": 40.0, "byok_total": 4.0,
        })
        self.assertTrue(row["available"])
        self.assertNotIn(SECRET, json.dumps(row))


REAL_BROKER_SCRIPT = r"""
import base64
import json
import sys
from pathlib import Path

import httpx

from hermes_cli.plugin_provider_requests import credentialed_provider_request

# Synthetic bearer only: no auth.json is written and this value is never a real grant.
import hermes_cli.auth_xai as auth_xai
auth_xai.resolve_xai_oauth_runtime_credentials = lambda **kwargs: {
    "api_key": "synthetic-installed-plugin-fixture",
    "base_url": "https://api.x.ai",
}

seen = []
GRPC = b"\x00\x00\x00\x07fixture"


def handler(request):
    body = request.content
    seen.append({
        "method": request.method,
        "url": str(request.url),
        "authorization": request.headers.get("Authorization"),
        "content_type": request.headers.get("Content-Type"),
        "body": base64.b64encode(body).decode("ascii"),
    })
    if request.url.path.endswith("/v1/billing"):
        return httpx.Response(200, json={"config": {"creditUsagePercent": 62.5,
                                                    "currentPeriod": {"type": "WEEKLY"}}})
    if request.url.path.endswith("/v1/settings"):
        return httpx.Response(200, json={"subscription_tier_display": "SuperGrok Heavy"})
    if request.url.path.endswith("GetGrokCreditsConfig"):
        return httpx.Response(200, content=GRPC,
                              headers={"content-type": "application/grpc-web+proto"})
    return httpx.Response(404)


real_client = httpx.Client


def factory(*args, **kwargs):
    kwargs["transport"] = httpx.MockTransport(handler)
    return real_client(*args, **kwargs)


httpx.Client = factory

billing = credentialed_provider_request(
    "xai-oauth", "GET",
    "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    headers={"Accept": "application/json", "x-xai-token-auth": "xai-grok-cli"})
settings = credentialed_provider_request(
    "xai-oauth", "GET", "https://cli-chat-proxy.grok.com/v1/settings",
    headers={"Accept": "application/json"})
grpc = credentialed_provider_request(
    "xai-oauth", "POST",
    "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig",
    content=b"\x00\x00\x00\x00\x00",
    headers={"Content-Type": "application/grpc-web+proto",
             "Accept": "application/grpc-web+proto"})

print(json.dumps({
    "home": __import__("os").environ.get("HERMES_HOME"),
    "plugin_file": __file__,
    "seen": seen,
    "billing": {"status": billing.status, "json": billing.json(),
                "headers": dict(billing.headers)},
    "settings": {"status": settings.status, "json": settings.json()},
    "grpc": {"status": grpc.status, "body": base64.b64encode(grpc.body).decode("ascii")},
}, sort_keys=True))
"""


class RealBrokerCoreCheckoutTests(unittest.TestCase):
    """The real helper, imported from a core checkout, called by an installed fixture."""

    @classmethod
    def setUpClass(cls):
        cls.core = Path(os.environ.get("HERMES_PU_CORE_CHECKOUT", DEFAULT_CORE_CHECKOUT))
        if not (cls.core / "hermes_cli" / "plugin_provider_requests.py").is_file():
            raise unittest.SkipTest(
                "core checkout with hermes_cli/plugin_provider_requests.py not found; "
                "set HERMES_PU_CORE_CHECKOUT")

    def test_proxy_and_grpc_from_installed_plugin_fixture(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            plugin = home / "plugins" / "provider-usage-fixture"
            plugin.mkdir(parents=True)
            (plugin / "plugin.yaml").write_text(
                "name: provider-usage-fixture\nrequires_auth: [xai-oauth]\n", encoding="utf-8")
            script = plugin / "call_broker.py"
            script.write_text(REAL_BROKER_SCRIPT, encoding="utf-8")

            env = os.environ.copy()
            env["HERMES_HOME"] = str(home)
            env["PYTHONPATH"] = str(self.core)
            env.pop("HERMES_PU_ACCEPT_MIGRATION", None)
            completed = subprocess.run(
                [sys.executable, str(script)], cwd=str(home), env=env,
                capture_output=True, text=True, timeout=90,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload = json.loads(completed.stdout.strip().splitlines()[-1])

            self.assertEqual(Path(payload["home"]), home)
            self.assertTrue(Path(payload["plugin_file"]).is_relative_to(plugin))
            self.assertFalse((home / "auth.json").exists())
            self.assertEqual(payload["billing"]["status"], 200)
            self.assertEqual(payload["billing"]["json"]["config"]["creditUsagePercent"], 62.5)
            self.assertEqual(payload["settings"]["json"]["subscription_tier_display"],
                             "SuperGrok Heavy")
            self.assertEqual(base64.b64decode(payload["grpc"]["body"]),
                             b"\x00\x00\x00\x07fixture")

            self.assertEqual([item["method"] for item in payload["seen"]],
                             ["GET", "GET", "POST"])
            for item in payload["seen"]:
                self.assertEqual(item["authorization"], "Bearer synthetic-installed-plugin-fixture")
            self.assertEqual(payload["seen"][2]["content_type"], "application/grpc-web+proto")
            self.assertEqual(base64.b64decode(payload["seen"][2]["body"]), b"\x00\x00\x00\x00\x00")
            # The broker returns only status/headers/body: no bearer in the result.
            self.assertNotIn("synthetic-installed-plugin-fixture",
                             json.dumps(payload["billing"]["headers"]))


if __name__ == "__main__":
    unittest.main()
