"""Compatibility mode: no core broker route, core's own resolver, one request, no token kept.

This is the fallback for builds that predate the xAI broker. It must never be a second
token reader: it resolves through Hermes's locked sign-in path, sends to xAI's own hosts
only, and gives the caller data with no credential in it.
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = ROOT / "dashboard" / "plugin_api.py"

_HOME = tempfile.mkdtemp(prefix="provider-usage-compat-home-")
os.environ["HERMES_HOME"] = _HOME


def load_backend():
    module_name = "provider_usage_plugin_api_compat"
    spec = importlib.util.spec_from_file_location(module_name, BACKEND_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class _FakeResponse:
    status_code = 200
    headers = {"content-type": "application/json"}
    content = b'{"ok": true}'


class CompatModeTest(unittest.TestCase):
    def setUp(self):
        self.api = load_backend()
        self.api._hermes_home = lambda: Path(_HOME)  # type: ignore[attr-defined]
        self._original_auth_xai = sys.modules.get("hermes_cli.auth_xai")
        os.environ.pop(self.api._COMPAT_ENV, None)

    def tearDown(self):
        os.environ.pop(self.api._COMPAT_ENV, None)
        if self._original_auth_xai is not None:
            sys.modules["hermes_cli.auth_xai"] = self._original_auth_xai
        else:
            sys.modules.pop("hermes_cli.auth_xai", None)

    def test_it_is_off_unless_the_user_turns_it_on(self):
        self.assertFalse(self.api._compat_enabled())

    def test_the_env_switch_and_the_settings_file_both_enable_it(self):
        os.environ[self.api._COMPAT_ENV] = "1"
        self.assertTrue(self.api._compat_enabled())
        os.environ.pop(self.api._COMPAT_ENV, None)

        directory = Path(_HOME) / "provider-usage"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "settings.json").write_text(json.dumps({"compat_oauth_reads": True}))
        try:
            self.assertTrue(self.api._compat_enabled())
        finally:
            (directory / "settings.json").unlink()

    def test_disabled_mode_explains_the_upgrade_instead_of_reading_a_token(self):
        with self.assertRaises(self.api._XaiBrokerUnavailable) as caught:
            self.api._xai_without_broker("GET", "https://cli-chat-proxy.grok.com/v1/billing")
        self.assertIn("compatibility mode is off", str(caught.exception).lower())

    def test_it_refuses_a_host_outside_xai(self):
        with self.assertRaises(self.api._XaiAuthFailure):
            self.api._compat_xai_request("GET", "https://evil.example/v1/billing")
        with self.assertRaises(self.api._XaiAuthFailure):
            self.api._compat_xai_request("GET", "http://cli-chat-proxy.grok.com/v1/billing")

    def test_the_request_carries_the_resolver_token_and_never_returns_it(self):
        seen = {}

        class FakeClient:
            def __init__(self, *args, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def request(self, method, url, headers=None, content=None):
                seen.update(method=method, url=url, headers=dict(headers or {}), content=content)
                return _FakeResponse()

        sys.modules["hermes_cli.auth_xai"] = SimpleNamespace(  # type: ignore[assignment]
            resolve_xai_oauth_runtime_credentials=lambda: {"api_key": "tok_live_123"})

        with mock.patch.object(self.api.httpx, "Client", FakeClient):
            response = self.api._compat_xai_request(
                "GET", "https://cli-chat-proxy.grok.com/v1/settings",
                headers={"Authorization": "Bearer attacker", "Host": "evil.example", "Accept": "application/json"})

        self.assertEqual(seen["headers"]["Authorization"], "Bearer tok_live_123")
        self.assertNotIn("Host", seen["headers"])
        self.assertEqual(seen["headers"]["Accept"], "application/json")
        self.assertEqual(response.status, 200)
        self.assertNotIn("tok_live_123", repr(response.headers) + response.body.decode())

    def test_a_resolver_failure_reports_the_type_and_not_the_secret(self):
        def boom():
            raise RuntimeError("refresh token rt_secret_value rejected")

        sys.modules["hermes_cli.auth_xai"] = SimpleNamespace(  # type: ignore[assignment]
            resolve_xai_oauth_runtime_credentials=boom)

        with self.assertRaises(self.api._XaiAuthFailure) as caught:
            self.api._compat_xai_request("GET", "https://cli-chat-proxy.grok.com/v1/billing")

        self.assertIn("RuntimeError", str(caught.exception))
        self.assertNotIn("rt_secret_value", str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)


if __name__ == "__main__":
    unittest.main()
