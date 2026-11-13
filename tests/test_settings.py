"""Settings: one allowlisted file per profile, validated before it is stored."""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = ROOT / "dashboard" / "plugin_api.py"

_HOME = tempfile.mkdtemp(prefix="provider-usage-settings-home-")
os.environ["HERMES_HOME"] = _HOME


def load_backend():
    module_name = "provider_usage_plugin_api_settings"
    spec = importlib.util.spec_from_file_location(module_name, BACKEND_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class SettingsTest(unittest.TestCase):
    def setUp(self):
        self.api = load_backend()
        self.api._hermes_home = lambda: Path(_HOME)  # type: ignore[attr-defined]
        os.environ.pop(self.api._COMPAT_ENV, None)
        self.path = Path(_HOME) / "provider-usage" / "settings.json"
        if self.path.exists():
            self.path.unlink()

    def tearDown(self):
        os.environ.pop(self.api._COMPAT_ENV, None)

    def test_defaults_are_returned_with_the_spec_the_ui_renders(self):
        payload = self.api.get_settings()
        self.assertTrue(payload["ok"])
        self.assertIs(payload["settings"]["compat_oauth_reads"], False)
        keys = {item["key"] for item in payload["spec"]}
        self.assertIn("compat_oauth_reads", keys)
        self.assertTrue(all({"type", "default", "label", "help"} <= set(item) for item in payload["spec"]))

    def test_a_valid_change_is_stored_and_takes_effect(self):
        result = self.api.put_settings({"settings": {"compat_oauth_reads": True}})
        self.assertTrue(result["ok"], result)
        self.assertIs(result["settings"]["compat_oauth_reads"], True)
        self.assertIs(json.loads(self.path.read_text("utf-8"))["compat_oauth_reads"], True)
        self.assertTrue(self.api._compat_enabled())
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])

    def test_an_unknown_key_is_refused_and_nothing_is_written(self):
        result = self.api.put_settings({"settings": {"compat_oauth_reads": True, "telemetry": True}})
        self.assertFalse(result["ok"])
        self.assertTrue(any("telemetry" in error for error in result["errors"]))
        self.assertFalse(self.path.exists())
        self.assertFalse(self.api._compat_enabled())

    def test_a_wrong_type_is_refused_instead_of_coerced(self):
        result = self.api.put_settings({"settings": {"compat_oauth_reads": "yes"}})
        self.assertFalse(result["ok"])
        self.assertTrue(any("true or false" in error for error in result["errors"]))
        self.assertFalse(self.path.exists())

    def test_a_corrupt_file_falls_back_to_defaults(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("{not json", "utf-8")
        self.assertIs(self.api._read_settings()["compat_oauth_reads"], False)
        self.assertFalse(self.api._compat_enabled())

    def test_the_routes_are_registered(self):
        routes = {(getattr(route, "path", ""), tuple(sorted(getattr(route, "methods", ()))))
                  for route in self.api.router.routes}
        self.assertIn(("/settings", ("GET",)), routes)
        self.assertIn(("/settings", ("PUT",)), routes)


if __name__ == "__main__":
    unittest.main()
