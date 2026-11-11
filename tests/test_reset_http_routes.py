"""Regression: preview and confirm must share one short-lived store per scope.

The defect under test is route-level: ``plugin_api`` constructed a fresh
``ResetService`` (and therefore a fresh ``ResetConfirmationStore``) for every
HTTP request, so a token issued by ``POST /reset/preview`` could never be
found by ``POST /reset/confirm``.  These tests therefore drive the actual
registered FastAPI routes through ``TestClient`` -- not one service instance.

Every test uses a synthetic, duck-typed core.  No credential is read, no
network call is made, and no real reset can be redeemed.
"""

import contextlib
import importlib.util
import sys
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_API = ROOT / "dashboard" / "plugin_api.py"
INTENT = "redeem_one_banked_codex_reset"
IDENTITY = "codex:acct-1:user-1"
OTHER = "codex:acct-2:user-2"


def load_plugin_api():
    name = "provider_usage_plugin_api_route_tests"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_API)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


plugin_api = load_plugin_api()


@dataclass
class FakeWindow:
    label: str = "Session"
    used_percent: float = 100.0
    reset_at: str = None
    scope: str = "account"


@dataclass
class FakeSnapshot:
    identity: str = IDENTITY
    raw: dict = field(default_factory=dict)
    windows: list = field(default_factory=list)


class FakeCore:
    """Stock-shaped synthetic core: scope/read/redeem/supports only."""

    def __init__(self, *, identity=IDENTITY, available=2, applicable=1):
        self.identity = identity
        self.available = available
        self.applicable = applicable
        self.read_calls = 0
        self.redeem_calls = 0

    def scope(self, profile):
        return contextlib.nullcontext()

    def read(self):
        self.read_calls += 1
        raw = {"rate_limit_reset_credits": {"available_count": self.available}}
        if self.applicable is not None:
            raw["rate_limit_reset_credits"]["applicable_available_count"] = self.applicable
        return FakeSnapshot(self.identity, raw, [FakeWindow(), FakeWindow("Weekly", 40.0)])

    def redeem(self):
        self.redeem_calls += 1
        self.available = max(0, self.available - 1)
        return SimpleNamespace(status="reset", message="synthetic", available_count=self.available, windows_reset=2)

    def supports_redemption(self):
        return True


class ResetHttpRouteTests(unittest.TestCase):
    def setUp(self):
        self.reset_module = plugin_api._reset_service_module()
        self.assertIsNotNone(self.reset_module, "reset service module must load")
        self.core = FakeCore()
        patcher = mock.patch.object(self.reset_module, "HermesCoreSeam", lambda profile=None: self.core)
        patcher.start()
        self.addCleanup(patcher.stop)
        stores = getattr(plugin_api, "_RESET_STORES", None)
        if isinstance(stores, dict):
            stores.clear()
        app = FastAPI()
        app.include_router(plugin_api.router)
        self.client = TestClient(app)

    def _post(self, path, body, session="session-a", token_header="x-hermes-session-token"):
        headers = {token_header: session} if session else {}
        return self.client.post(path, json=body, headers=headers)

    def _preview(self, *, session="session-a", identity=IDENTITY):
        response = self._post("/reset/preview", {"identity_id": identity}, session=session)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def _confirm(self, token, *, session="session-a", identity=IDENTITY, confirmed=None):
        body = {
            "identity_id": identity,
            "token": token,
            "confirmed_account": confirmed if confirmed is not None else identity,
            "confirmed_intent": INTENT,
        }
        response = self._post("/reset/confirm", body, session=session)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_preview_then_confirm_across_http_requests(self):
        preview = self._preview()
        self.assertEqual(preview["state"], "ready", preview)
        token = preview["confirmation"]["token"]

        result = self._confirm(token)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["status"], "reset", result)
        self.assertEqual(result["credit_consumed"], "yes", result)
        self.assertEqual(result["available_before"], 2, result)
        self.assertEqual(result["available_after"], 1, result)
        self.assertEqual(self.core.redeem_calls, 1)
        self.assertEqual(self.core.read_calls, 3)  # preview, pre-redeem recheck, readback

    def test_confirmation_token_is_single_use_on_replay(self):
        token = self._preview()["confirmation"]["token"]
        first = self._confirm(token)
        self.assertTrue(first["ok"], first)

        replay = self._confirm(token)

        self.assertFalse(replay["ok"], replay)
        self.assertEqual(replay["status"], "invalid_or_used", replay)
        self.assertEqual(replay["credit_consumed"], "no", replay)
        self.assertEqual(self.core.redeem_calls, 1, "replay must never redeem again")

    def test_expired_confirmation_is_refused_without_redeem(self):
        clock = [1000.0]
        with mock.patch.object(self.reset_module, "time", SimpleNamespace(monotonic=lambda: clock[0])):
            token = self._preview()["confirmation"]["token"]
            clock[0] += self.reset_module._DEFAULT_TTL_SECONDS + 1
            result = self._confirm(token)

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["status"], "expired", result)
        self.assertEqual(result["reason"], "token_expired", result)
        self.assertEqual(self.core.redeem_calls, 0)

    def test_independent_dashboard_session_cannot_consume(self):
        token = self._preview(session="session-a")["confirmation"]["token"]

        result = self._confirm(token, session="session-b")

        self.assertFalse(result["ok"], result)
        self.assertIn(result["status"], {"invalid_or_used", "refused"}, result)
        self.assertEqual(result["credit_consumed"], "no", result)
        self.assertEqual(self.core.redeem_calls, 0)

    def test_token_is_bound_to_the_previewed_account(self):
        token = self._preview(identity=IDENTITY)["confirmation"]["token"]

        result = self._confirm(token, identity=OTHER, confirmed=OTHER)

        self.assertFalse(result["ok"], result)
        self.assertIn(result["status"], {"invalid_or_used", "refused"}, result)
        self.assertEqual(result["credit_consumed"], "no", result)
        self.assertEqual(self.core.redeem_calls, 0)


if __name__ == "__main__":
    unittest.main()
