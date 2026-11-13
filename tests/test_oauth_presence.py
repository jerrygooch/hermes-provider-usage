"""A signed-in OAuth provider is configured even when no env key exists."""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = ROOT / "dashboard" / "plugin_api.py"

_HOME = tempfile.mkdtemp(prefix="provider-usage-oauth-home-")
os.environ["HERMES_HOME"] = _HOME


def load_backend():
    spec = importlib.util.spec_from_file_location("provider_usage_plugin_api_oauth", BACKEND_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["provider_usage_plugin_api_oauth"] = module
    spec.loader.exec_module(module)
    return module


class OAuthPresenceTest(unittest.TestCase):
    def setUp(self):
        self.api = load_backend()
        self.addCleanup(setattr, self.api, "_core_helper", self.api._core_helper)
        self.addCleanup(setattr, self.api, "_credential_summary", self.api._credential_summary)

    def _helper(self, payload):
        def _core_helper(name):
            if name == "get_xai_oauth_auth_status":
                return lambda: payload
            return None
        setattr(self.api, '_core_helper', _core_helper)

    def test_a_signed_in_grok_account_counts_as_configured(self):
        setattr(self.api, '_credential_summary', lambda provider: None)
        self._helper({"logged_in": True, "auth_mode": "oauth_device_code"})
        self.assertEqual(self.api._local_presence("xai-oauth"), (True, "oauth", True))

    def test_a_signed_out_account_is_known_and_not_configured(self):
        setattr(self.api, '_credential_summary', lambda provider: None)
        self._helper({"logged_in": False})
        self.assertEqual(self.api._local_presence("xai-oauth"), (False, "none", True))

    def test_the_status_token_never_escapes_the_probe(self):
        # Core's status snapshot carries an api_key field. Only the boolean is used.
        setattr(self.api, '_credential_summary', lambda provider: None)
        self._helper({"logged_in": True, "api_key": "token-should-not-escape"})
        outcome = self.api._local_presence("xai-oauth")
        self.assertNotIn("token-should-not-escape", repr(outcome))

    def test_a_missing_core_helper_leaves_presence_unknown(self):
        setattr(self.api, '_credential_summary', lambda provider: None)
        setattr(self.api, '_core_helper', lambda name: None)
        configured, source, known = self.api._local_presence("xai-oauth")
        self.assertFalse(configured)
        self.assertEqual(source, "none")
        self.assertFalse(known)

    def test_a_provider_with_no_oauth_probe_is_unaffected(self):
        setattr(self.api, '_credential_summary', lambda provider: {"configured": True, "source": "env"})
        self._helper({"logged_in": True})
        self.assertEqual(self.api._local_presence("deepseek"), (True, "env", True))

    def test_grok_reaches_the_inventory_when_signed_in(self):
        setattr(self.api, '_credential_summary', lambda provider: None)
        self._helper({"logged_in": True})
        ids = {row["id"] for row in self.api._inventory()}
        self.assertIn("xai-oauth", ids)


if __name__ == "__main__":
    unittest.main()
