"""Schema, trust-gate, SSRF, cache, mapping, packaging, and catalog tests.

Run with:
    python -m unittest tests.test_declarative_definitions -v
"""

import copy
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import httpx

ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = ROOT / "dashboard" / "plugin_api.py"


def load_backend():
    module_name = "provider_usage_plugin_api_tests"
    spec = importlib.util.spec_from_file_location(module_name, BACKEND_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


backend = load_backend()


def public_dns(*_args, **_kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]


def private_dns(*_args, **_kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]


def base_definition(**overrides):
    definition = {
        "schema": backend._DEFINITION_SCHEMA,
        "id": "example-usage",
        "name": "Example usage",
        "description": "Test definition.",
        "version": 1,
        "docs_url": "https://example.com/docs",
        "request": {
            "url": "https://api.example.com/v1/usage",
            "method": "GET",
            "hosts": ["api.example.com"],
            "headers": [
                {
                    "name": "Authorization",
                    "prefix": "Bearer ",
                    "credential": {"source": "env", "name": "EXAMPLE_API_KEY"},
                }
            ],
        },
        "cache_ttl_seconds": 60,
        "mapping": {
            "title": "Example API",
            "plan": {"path": "plan"},
            "windows": [
                {
                    "label": "Daily requests",
                    "kind": "daily",
                    "rolling": True,
                    "unit": "requests",
                    "used": {"path": "usage.used"},
                    "limit": {"path": "usage.limit"},
                    "reset_at": {"path": "usage.reset", "format": "unix"},
                }
            ],
            "balances": [],
            "details": [{"path": "account.name", "prefix": "Account: "}],
        },
    }
    for key, value in overrides.items():
        definition[key] = value
    return definition


def validate(raw, *, allow_override=True, source="profile"):
    return backend._validate_definition(raw, source=source, allow_override=allow_override)


class IsolatedHome(unittest.TestCase):
    """Every test gets its own canonical home and definition directory."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.home = root / "home"
        self.home.mkdir()
        self.defs = root / "defs"
        self.defs.mkdir()
        self.env = mock.patch.dict(
            os.environ,
            {
                "HERMES_HOME": str(self.home),
                "HERMES_PROVIDER_USAGE_DEFINITIONS": str(self.defs),
            },
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        backend._DEFINITION_CACHE.clear()
        self.addCleanup(backend._DEFINITION_CACHE.clear)

    def approve(self, definition, home=None):
        return backend.write_definition_approval(definition, home=home or self.home)

    def write(self, name, payload, directory=None):
        (Path(directory or self.defs) / name).write_text(json.dumps(payload), encoding="utf-8")

    def manifest(self, home=None):
        return backend._definition_approval_path(home or self.home)


class ValidationTests(unittest.TestCase):
    def assert_error(self, raw, fragment, **kwargs):
        definition, errors, _ = validate(raw, **kwargs)
        self.assertIsNone(definition)
        self.assertTrue(any(fragment in error for error in errors), errors)

    def test_valid_definition_normalizes(self):
        definition, errors, warnings = validate(base_definition())
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])
        self.assertEqual(definition["id"], "example-usage")
        self.assertEqual(definition["request"]["host"], "api.example.com")
        self.assertEqual(definition["request"]["path"], "/v1/usage")
        self.assertEqual(definition["mapping"]["windows"][0]["unit"], "requests")
        self.assertEqual(len(definition["_digest"]), 64)

    def test_https_only(self):
        raw = base_definition()
        raw["request"]["url"] = "http://api.example.com/v1/usage"
        self.assert_error(raw, "must use https")

    def test_private_and_ip_hosts_rejected(self):
        raw = base_definition()
        raw["request"]["url"] = "https://127.0.0.1/v1/usage"
        raw["request"]["hosts"] = ["127.0.0.1"]
        self.assert_error(raw, "public DNS hostname")

        raw = base_definition()
        raw["request"]["url"] = "https://localhost/v1/usage"
        raw["request"]["hosts"] = ["localhost"]
        self.assert_error(raw, "public DNS hostname")

    def test_host_allowlist_must_include_url_host(self):
        raw = base_definition()
        raw["request"]["hosts"] = ["other.example.com"]
        self.assert_error(raw, "must include the request host")

    def test_query_string_rejected(self):
        raw = base_definition()
        raw["request"]["url"] = "https://api.example.com/v1/usage?key=secret"
        self.assert_error(raw, "query strings")

    def test_literal_header_value_rejected(self):
        raw = base_definition()
        raw["request"]["headers"] = {"Authorization": "Bearer «redacted:sk-…»"}
        self.assert_error(raw, "must be a list")

    def test_credential_must_be_reference(self):
        raw = base_definition()
        raw["request"]["headers"][0]["credential"] = {
            "source": "env",
            "name": "EXAMPLE_API_KEY",
            "value": "synthetic-value",
        }
        self.assert_error(raw, "unknown key")

    def test_credential_source_rejected(self):
        raw = base_definition()
        raw["request"]["headers"][0]["credential"] = {"source": "file", "name": "EXAMPLE_API_KEY"}
        self.assert_error(raw, "must be env")

    def test_hermes_provider_reference_deferred_with_actionable_error(self):
        raw = base_definition()
        raw["request"]["headers"][0]["credential"] = {
            "source": "hermes_provider",
            "provider": "moonshot",
            "field": "api_key",
        }
        self.assert_error(raw, "hermes_provider references are not supported yet")

    def test_unknown_keys_rejected(self):
        raw = base_definition(script="fetch('https://evil')")
        self.assert_error(raw, "unknown key")
        raw = base_definition()
        raw["mapping"]["eval"] = "x"
        self.assert_error(raw, "unknown key")
        raw = base_definition()
        raw["approval"] = {"approved": True}
        self.assert_error(raw, "unknown key")

    def test_windows_and_windows_from_are_exclusive(self):
        raw = base_definition()
        raw["mapping"]["windows_from"] = {"path": "items", "label": {"path": "name"}}
        self.assert_error(raw, "not both")

    def test_unknown_path_segments_rejected(self):
        raw = base_definition()
        raw["mapping"]["windows"][0]["used"] = {"path": "a.__proto__"}
        self.assert_error(raw, "reserved path segment")
        raw = base_definition()
        raw["mapping"]["windows"][0]["used"] = {"path": "a.$where"}
        self.assert_error(raw, "invalid path segment")

    def test_mapping_requires_data(self):
        raw = base_definition()
        raw["mapping"]["windows"] = []
        raw["mapping"]["balances"] = []
        raw["mapping"]["details"] = []
        self.assert_error(raw, "must map at least one window or balance")

    def test_builtin_id_reserved(self):
        raw = base_definition(id="openrouter")
        self.assert_error(raw, "reserved for a built-in provider")

    def test_override_only_for_profile(self):
        raw = base_definition(id="moonshot-balance", override=True)
        self.assert_error(raw, "only allowed for profile-local", allow_override=False)

    def test_currency_required_for_money(self):
        raw = base_definition()
        raw["mapping"]["windows"][0]["unit"] = "usd"
        self.assert_error(raw, "is required for money/credit units")

    def test_cache_ttl_bounds(self):
        raw = base_definition(cache_ttl_seconds=5)
        self.assert_error(raw, "between 30 and 86400")
        raw = base_definition(cache_ttl_seconds=90000)
        self.assert_error(raw, "between 30 and 86400")

    def test_duplicate_header_rejected(self):
        raw = base_definition()
        raw["request"]["headers"].append(copy.deepcopy(raw["request"]["headers"][0]))
        self.assert_error(raw, "duplicate header")

    def test_malformed_ports_are_validation_errors_not_crashes(self):
        for url, fragment in (
            ("https://example.com:abc/docs", "invalid port"),
            ("https://example.com:99999/docs", "invalid port"),
            ("https://example.com:80/docs", "default HTTPS port 443"),
            ("https://:443/docs", "must include a host"),
        ):
            with self.subTest(url=url):
                raw = base_definition(docs_url=url)
                self.assert_error(raw, fragment)

    def test_deeply_nested_path_does_not_crash(self):
        raw = base_definition()
        raw["docs_url"] = "https://example.com/" + ("a/" * 2000)
        definition, errors, _ = validate(raw)
        self.assertIsNone(definition)
        self.assertTrue(errors)


class HttpRouteTests(IsolatedHome):
    def setUp(self):
        super().setUp()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        app.include_router(backend.router, prefix="/api/plugins/provider-usage")
        self.client = TestClient(app)

    def test_catalog_and_validate_over_http(self):
        response = self.client.get("/api/plugins/provider-usage/definitions/catalog")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("definitions", data)
        by_id = {entry["id"]: entry for entry in data["definitions"]}
        self.assertEqual(by_id["github-rate-limit"]["state"], "ready")
        self.assertEqual(by_id["moonshot-balance"]["state"], "available")
        self.assertNotIn(data["scope"], {"active", "default"})
        self.assertTrue(data["scope"].startswith("home:"))
        self.assertNotIn(str(self.home), response.text)

        raw = base_definition()
        response = self.client.post(
            "/api/plugins/provider-usage/definitions/validate",
            json={"definition": raw},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])
        self.assertEqual(response.json()["summary"]["host"], "api.example.com")
        self.assertTrue(response.json()["summary"]["requires_approval"])

    def test_catalog_survives_malformed_profile_files(self):
        bad = base_definition(id="bad-port", docs_url="https://example.com:abc/docs")
        self.write("bad-port.json", bad)
        self.write("good.json", base_definition(id="good-one"))
        (self.defs / "deep.json").write_text(
            '{"schema":"hermes.provider-usage.definition/1","id":"deep","x":'
            + "[" * 3000
            + "]" * 3000
            + "}",
            encoding="utf-8",
        )
        response = self.client.get("/api/plugins/provider-usage/definitions/catalog")
        self.assertEqual(response.status_code, 200)
        by_id = {entry["id"]: entry for entry in response.json()["definitions"]}
        self.assertEqual(by_id["bad-port"]["state"], "invalid")
        self.assertTrue(any("invalid port" in error for error in by_id["bad-port"]["errors"]))
        self.assertEqual(by_id["deep"]["state"], "invalid")
        self.assertEqual(by_id["good-one"]["state"], "requires_approval")
        self.assertIn("github-rate-limit", by_id)


class ValidateRouteTests(IsolatedHome):
    def test_valid_json_returns_summary_without_network(self):
        result = backend.definitions_validate({"json": json.dumps(base_definition())})
        self.assertTrue(result["ok"])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["summary"]["host"], "api.example.com")
        self.assertEqual(result["summary"]["windows"], 1)
        self.assertEqual(
            result["summary"]["credential_refs"],
            [{"source": "env", "name": "EXAMPLE_API_KEY"}],
        )
        self.assertEqual(result["summary"]["credential_labels"], ["EXAMPLE_API_KEY"])
        self.assertTrue(result["summary"]["requires_approval"])

    def test_invalid_json_returns_actionable_errors(self):
        result = backend.definitions_validate({"json": "{not json"})
        self.assertFalse(result["ok"])
        self.assertTrue(result["errors"][0].startswith("json:"))
        self.assertIsNone(result["summary"])

    def test_deep_json_returns_error_not_crash(self):
        result = backend.definitions_validate({"json": "[" * 5000 + "]" * 5000})
        self.assertFalse(result["ok"])
        self.assertIsNone(result["summary"])
        self.assertTrue(result["errors"])

    def test_schema_error_is_reported_without_network(self):
        raw = base_definition()
        raw["request"]["url"] = "http://localhost/usage"
        result = backend.definitions_validate({"definition": raw})
        self.assertFalse(result["ok"])
        self.assertTrue(any("must use https" in error for error in result["errors"]))

    def test_empty_body_is_an_error_not_a_crash(self):
        result = backend.definitions_validate(None)
        self.assertFalse(result["ok"])
        self.assertTrue(result["errors"])

    def test_validate_never_writes_an_approval(self):
        backend.definitions_validate({"definition": base_definition()})
        self.assertFalse(self.manifest().exists())


class LoadingAndCollisionTests(IsolatedHome):
    def test_catalog_endpoint_does_not_claim_connected_without_rows(self):
        loaded = backend._load_provider_definitions()
        prepared = backend._prepare_definitions(loaded)
        catalog = backend._definition_catalog(loaded, rows={}, prepared=prepared, profile="default")
        by_id = {entry["id"]: entry for entry in catalog["definitions"]}
        self.assertEqual(by_id["github-rate-limit"]["state"], "ready")
        self.assertEqual(by_id["moonshot-balance"]["state"], "available")
        self.assertIn("MOONSHOT_API_KEY", by_id["moonshot-balance"]["missing_credentials"])
        self.assertEqual(
            by_id["moonshot-balance"]["credential_refs"],
            [{"source": "env", "name": "MOONSHOT_API_KEY"}],
        )

    def test_bundled_catalog_loads(self):
        loaded = backend._load_provider_definitions()
        self.assertIn("github-rate-limit", loaded["valid"])
        self.assertIn("moonshot-balance", loaded["valid"])
        self.assertIn("elevenlabs-subscription", loaded["valid"])
        self.assertEqual(loaded["invalid"], [])

    def test_profile_definition_is_untrusted_by_default(self):
        self.write("custom.json", base_definition(id="custom-one"))
        loaded = backend._load_provider_definitions()
        prepared = backend._prepare_definitions(loaded)
        catalog = backend._definition_catalog(loaded, rows={}, prepared=prepared, profile="default")
        by_id = {entry["id"]: entry for entry in catalog["definitions"]}
        entry = by_id["custom-one"]
        self.assertEqual(entry["state"], "requires_approval")
        self.assertEqual(entry["trust"], "untrusted")
        self.assertTrue(entry["approval_required"])
        self.assertTrue(entry["approval"]["required"])
        self.assertFalse(entry["approval"]["approved"])
        self.assertFalse(self.manifest().exists())

    def test_prepare_does_not_read_secret_for_untrusted_profile_definition(self):
        self.write("custom.json", base_definition(id="custom-one"))
        loaded = backend._load_provider_definitions()

        def secret(name):
            if name == "EXAMPLE_API_KEY":
                raise AssertionError("catalog read a profile secret before approval")
            return None

        with mock.patch.object(backend, "_read_definition_secret", side_effect=secret):
            prepared = backend._prepare_definitions(loaded)
        self.assertEqual(prepared["custom-one"]["trust"], "untrusted")
        self.assertEqual(prepared["custom-one"]["headers"], {})
        self.assertEqual(prepared["github-rate-limit"]["trust"], "approved")

    def test_custom_collision_requires_explicit_override(self):
        custom = base_definition(id="moonshot-balance")
        self.write("collision.json", custom)
        loaded = backend._load_provider_definitions()
        invalid = [entry for entry in loaded["invalid"] if entry["file"] == "collision.json"]
        self.assertEqual(len(invalid), 1)
        self.assertIn("collides with bundled definition", invalid[0]["errors"][0])
        self.assertEqual(loaded["valid"]["moonshot-balance"]["definition"]["_source"], "bundled")

    def test_custom_override_replaces_bundled_and_still_requires_approval(self):
        custom = base_definition(id="moonshot-balance", override=True, name="Moonshot custom")
        self.write("override.json", custom)
        loaded = backend._load_provider_definitions()
        definition = loaded["valid"]["moonshot-balance"]["definition"]
        self.assertEqual(definition["_source"], "profile")
        self.assertEqual(definition["_overrides"], "bundled")
        self.assertNotIn("override.json", [entry["file"] for entry in loaded["invalid"]])
        trust, _ = backend._definition_trust(definition)
        self.assertEqual(trust, "untrusted")

    def test_duplicate_profile_id_first_wins(self):
        self.write("a.json", base_definition(id="custom-one"))
        self.write("b.json", base_definition(id="custom-one"))
        loaded = backend._load_provider_definitions()
        self.assertEqual(loaded["valid"]["custom-one"]["file"], "a.json")
        invalid = [entry for entry in loaded["invalid"] if entry["file"] == "b.json"]
        self.assertEqual(len(invalid), 1)
        self.assertIn("duplicate profile definition", invalid[0]["errors"][0])

    def test_invalid_file_does_not_break_other_definitions(self):
        (self.defs / "broken.json").write_text("{not json", encoding="utf-8")
        self.write("good.json", base_definition(id="custom-good"))
        loaded = backend._load_provider_definitions()
        self.assertIn("custom-good", loaded["valid"])
        self.assertTrue(any(entry["file"] == "broken.json" for entry in loaded["invalid"]))

    def test_one_unexpected_validation_exception_is_contained(self):
        self.write("boom.json", base_definition(id="boom"))
        self.write("good.json", base_definition(id="custom-good"))
        original = backend._validate_definition

        def flaky(raw, *, source, allow_override):
            if isinstance(raw, dict) and raw.get("id") == "boom":
                raise RuntimeError("synthetic validator fault")
            return original(raw, source=source, allow_override=allow_override)

        with mock.patch.object(backend, "_validate_definition", side_effect=flaky):
            loaded = backend._load_provider_definitions()
        self.assertIn("custom-good", loaded["valid"])
        boom = [entry for entry in loaded["invalid"] if entry["file"] == "boom.json"]
        self.assertEqual(len(boom), 1)
        self.assertIn("validation failed unexpectedly", boom[0]["errors"][0])


class MappingTests(unittest.TestCase):
    def definition(self):
        raw = base_definition()
        raw["mapping"] = {
            "title": "Example",
            "plan": {"path": "plan"},
            "windows": [
                {
                    "label": "5-hour",
                    "kind": "five_hour",
                    "unit": "requests",
                    "used": {"path": "five.used"},
                    "limit": {"path": "five.limit"},
                    "reset_at": {"path": "five.reset", "format": "unix"},
                },
                {
                    "label": "Monthly spend",
                    "kind": "monthly",
                    "unit": "usd",
                    "currency": "EUR",
                    "used": {"path": "money.spent"},
                    "limit": {"path": "money.allowance"},
                    "remaining": {"path": "money.remaining"},
                    "reset_at": {"path": "money.reset", "format": "unix_ms"},
                },
                {
                    "label": "Unknown window",
                    "kind": "custom",
                    "unit": "custom",
                    "used": {"path": "missing.path"},
                    "limit": {"path": "five.limit"},
                },
            ],
            "balances": [
                {
                    "label": "Credit",
                    "amount": {"path": "balance.amount"},
                    "currency": {"path": "balance.currency"},
                    "unit": "currency",
                }
            ],
            "details": [{"path": "account.name", "prefix": "Account: "}],
        }
        definition, errors, _ = validate(raw)
        self.assertEqual(errors, [])
        return definition

    def test_multiple_windows_units_and_unknown(self):
        row = backend._normalize_definition_row(
            self.definition(),
            {
                "plan": "Pro",
                "five": {"used": 25, "limit": 100, "reset": "1800000000"},
                "money": {"spent": 3, "allowance": 12, "remaining": 9, "reset": 1800000000000},
                "balance": {"amount": 4.5, "currency": "eur"},
                "account": {"name": "Sample"},
            },
            fetched_at=backend._now(),
            cache="miss",
            profile="default",
        )
        self.assertEqual(row["state"], "ok")
        self.assertTrue(row["available"])
        windows = row["limits"][0]["windows"]
        self.assertEqual(windows[0]["remaining_percent"], 75.0)
        self.assertEqual(windows[0]["detail"], "25 of 100 requests")
        self.assertIsNotNone(windows[0]["reset_at"])
        self.assertEqual(windows[1]["remaining_percent"], 75.0)
        self.assertEqual(windows[1]["currency"], "EUR")
        self.assertEqual(windows[1]["allowance_usd"], 12.0)
        self.assertEqual(windows[1]["remaining_usd"], 9.0)
        self.assertEqual(windows[1]["spent_usd"], 3.0)
        self.assertEqual(windows[2]["used_percent"], None)
        self.assertEqual(windows[2]["remaining_percent"], None)
        self.assertIsNone(windows[2]["detail"])
        self.assertEqual(row["balances"][0]["currency"], "EUR")
        self.assertIn("Account: Sample", row["details"])

    def test_unmapped_payload_is_unverified_not_zero(self):
        row = backend._normalize_definition_row(
            self.definition(),
            {"plan": "Pro"},
            fetched_at=backend._now(),
            cache="miss",
            profile="default",
        )
        self.assertEqual(row["state"], "unverified")
        self.assertFalse(row["available"])
        self.assertIn("produced no windows or balances", row["unavailable_reason"])
        self.assertFalse(row["limits"])
        self.assertFalse(row["balances"])

    def test_unresolved_currency_is_unknown_not_usd(self):
        raw = base_definition()
        raw["mapping"] = {
            "balances": [
                {
                    "label": "Credit",
                    "amount": {"path": "balance.amount"},
                    "currency": {"path": "balance.currency"},
                }
            ]
        }
        definition, errors, _ = validate(raw)
        self.assertEqual(errors, [])
        row = backend._normalize_definition_row(
            definition,
            {"balance": {"amount": 4.5}},
            fetched_at=backend._now(),
            cache="miss",
            profile="default",
        )
        self.assertEqual(row["balances"][0]["currency"], "UNKNOWN")

    def test_unresolved_window_currency_is_unknown_not_usd(self):
        raw = base_definition()
        raw["mapping"] = {
            "windows": [
                {
                    "label": "Monthly spend",
                    "kind": "monthly",
                    "unit": "usd",
                    "currency": {"path": "money.currency"},
                    "used": {"path": "money.spent"},
                    "limit": {"path": "money.allowance"},
                }
            ]
        }
        definition, errors, _ = validate(raw)
        self.assertEqual(errors, [])
        row = backend._normalize_definition_row(
            definition,
            {"money": {"spent": 1, "allowance": 10}},
            fetched_at=backend._now(),
            cache="miss",
            profile="default",
        )
        self.assertEqual(row["limits"][0]["windows"][0]["currency"], "UNKNOWN")

    def test_rolling_defaults_only_for_rolling_kind(self):
        raw = base_definition()
        raw["mapping"] = {
            "windows": [
                {
                    "label": "Daily",
                    "kind": "daily",
                    "unit": "requests",
                    "used": {"path": "a.used"},
                    "limit": {"path": "a.limit"},
                },
                {
                    "label": "Rolling",
                    "kind": "rolling",
                    "unit": "requests",
                    "used": {"path": "b.used"},
                    "limit": {"path": "b.limit"},
                },
            ]
        }
        definition, errors, _ = validate(raw)
        self.assertEqual(errors, [])
        self.assertFalse(definition["mapping"]["windows"][0]["rolling"])
        self.assertTrue(definition["mapping"]["windows"][1]["rolling"])
        row = backend._normalize_definition_row(
            definition,
            {"a": {"used": 1, "limit": 2}, "b": {"used": 1, "limit": 2}},
            fetched_at=backend._now(),
            cache="miss",
            profile="default",
        )
        self.assertFalse(row["limits"][0]["windows"][0]["rolling"])
        self.assertTrue(row["limits"][0]["windows"][1]["rolling"])

    def test_partial_mapping_rows_emit_warnings(self):
        raw = base_definition()
        raw["mapping"] = {
            "windows_from": {
                "path": "items",
                "label": {"path": "name"},
                "unit": "requests",
                "used": {"path": "used"},
                "limit": {"path": "limit"},
            },
            "balances": [
                {"label": "Present", "amount": {"path": "balance.amount"}, "currency": "USD"},
                {"label": "Missing", "amount": {"path": "balance.missing"}, "currency": "USD"},
            ],
        }
        definition, errors, _ = validate(raw)
        self.assertEqual(errors, [])
        row = backend._normalize_definition_row(
            definition,
            {
                "items": [
                    {"name": "A", "used": 1, "limit": 2},
                    {"used": 3, "limit": 4},
                ],
                "balance": {"amount": 5},
            },
            fetched_at=backend._now(),
            cache="miss",
            profile="default",
        )
        self.assertEqual(row["state"], "ok")
        self.assertIn("1 of 2 mapped windows had no usable values", " ".join(row["details"]))
        self.assertIn("Balance 'Missing' had no mapped amount", " ".join(row["details"]))

    def test_missing_windows_from_path_emits_warning(self):
        raw = base_definition()
        raw["mapping"] = {
            "windows_from": {
                "path": "nope",
                "label": {"path": "name"},
                "used": {"path": "used"},
                "limit": {"path": "limit"},
            }
        }
        definition, errors, _ = validate(raw)
        self.assertEqual(errors, [])
        row = backend._normalize_definition_row(
            definition,
            {},
            fetched_at=backend._now(),
            cache="miss",
            profile="default",
        )
        self.assertIn("was not found", " ".join(row["details"]))

    def test_windows_from_array(self):
        raw = base_definition()
        raw["mapping"] = {
            "title": "Array API",
            "windows_from": {
                "path": "data.windows",
                "label": {"path": "name"},
                "kind": "custom",
                "unit": "tokens",
                "used": {"path": "used"},
                "limit": {"path": "limit"},
            },
        }
        definition, errors, _ = validate(raw)
        self.assertEqual(errors, [])
        row = backend._normalize_definition_row(
            definition,
            {"data": {"windows": [
                {"name": "Input", "used": 10, "limit": 100},
                {"name": "Output", "used": 20, "limit": 50},
            ]}},
            fetched_at=backend._now(),
            cache="miss",
            profile="default",
        )
        self.assertEqual([w["label"] for w in row["limits"][0]["windows"]], ["Input", "Output"])
        self.assertEqual(row["limits"][0]["windows"][1]["remaining_percent"], 60.0)


class ApprovalGateTests(IsolatedHome):
    def setUp(self):
        super().setUp()
        self.dns = mock.patch.object(backend.socket, "getaddrinfo", side_effect=public_dns)
        self.dns.start()
        self.addCleanup(self.dns.stop)

    def profile_definition(self, **overrides):
        raw = base_definition(**overrides)
        definition, errors, _ = validate(raw)
        self.assertEqual(errors, [])
        return definition

    def test_untrusted_definition_is_requires_approval_without_secret_or_network(self):
        definition = self.profile_definition()
        requests = []

        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={"usage": {"used": 1, "limit": 2}})

        with mock.patch.object(
            backend, "_read_definition_secret", side_effect=AssertionError("secret read before approval")
        ):
            row = backend._fetch_declarative_cached(
                definition,
                profile="default",
                transport=httpx.MockTransport(handler),
            )
        self.assertEqual(row["state"], "requires_approval")
        self.assertEqual(row["trust"], "untrusted")
        self.assertFalse(row["available"])
        self.assertEqual(requests, [])
        self.assertEqual(row["approval"]["credential_refs"], [{"source": "env", "name": "EXAMPLE_API_KEY"}])
        self.assertTrue(row["approval"]["required"])
        self.assertFalse(row["approval"]["approved"])

    def test_exfiltration_definition_cannot_fetch_before_approval(self):
        raw = base_definition(id="evil-usage")
        raw["request"]["url"] = "https://evil.example.net/collect"
        raw["request"]["hosts"] = ["evil.example.net"]
        definition, errors, _ = validate(raw)
        self.assertEqual(errors, [])
        requests = []

        with mock.patch.object(
            backend, "_read_definition_secret", side_effect=AssertionError("secret read before approval")
        ):
            row = backend._fetch_declarative_cached(
                definition,
                profile="default",
                transport=httpx.MockTransport(lambda request: requests.append(request) or httpx.Response(200, json={})),
            )
        self.assertEqual(row["state"], "requires_approval")
        self.assertEqual(requests, [])
        self.assertEqual(row["provenance"]["endpoint_host"], "evil.example.net")

    def test_approved_definition_fetches_through_secret_scope(self):
        definition = self.profile_definition()
        self.approve(definition)
        seen = {}

        def handler(request):
            seen["authorization"] = request.headers.get("authorization")
            return httpx.Response(
                200,
                json={"plan": "Pro", "usage": {"used": 5, "limit": 10, "reset": 1800000000}},
                headers={"content-type": "application/json"},
            )

        with mock.patch("agent.secret_scope.get_secret", return_value="synthetic-test-value") as getter:
            row = backend._fetch_declarative_cached(
                definition,
                profile="default",
                transport=httpx.MockTransport(handler),
            )
        self.assertEqual(row["state"], "ok")
        self.assertEqual(row["trust"], "approved")
        self.assertEqual(seen["authorization"], "Bearer synthetic-test-value")
        getter.assert_called_once_with("EXAMPLE_API_KEY")

    def test_secret_api_none_is_not_backfilled_from_os_environ(self):
        definition = self.profile_definition()
        self.approve(definition)
        with mock.patch.dict(os.environ, {"EXAMPLE_API_KEY": "synthetic-env-value"}), mock.patch(
            "agent.secret_scope.get_secret", return_value=None
        ):
            row = backend._fetch_declarative_cached(
                definition,
                profile="default",
                transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})),
            )
        self.assertEqual(row["state"], "not_connected")
        self.assertIn("EXAMPLE_API_KEY", row["unavailable_reason"])

    def test_secret_with_line_break_is_not_used_as_a_header(self):
        definition = self.profile_definition()
        self.approve(definition)
        requests = []
        with mock.patch("agent.secret_scope.get_secret", return_value="synthetic\nInjected: yes"):
            row = backend._fetch_declarative_cached(
                definition,
                profile="default",
                transport=httpx.MockTransport(lambda request: requests.append(request) or httpx.Response(200, json={})),
            )
        self.assertEqual(row["state"], "not_connected")
        self.assertEqual(requests, [])

    def test_fingerprint_change_revokes_approval(self):
        definition = self.profile_definition()
        self.approve(definition)
        changed = self.profile_definition(version=2)
        requests = []
        with mock.patch.object(
            backend, "_read_definition_secret", side_effect=AssertionError("secret read after revocation")
        ):
            row = backend._fetch_declarative_cached(
                changed,
                profile="default",
                transport=httpx.MockTransport(lambda request: requests.append(request) or httpx.Response(200, json={})),
            )
        self.assertEqual(row["state"], "blocked")
        self.assertIn("changed after it was approved", row["unavailable_reason"])
        self.assertEqual(requests, [])

    def test_endpoint_and_reference_tampering_blocks(self):
        definition = self.profile_definition()
        self.approve(definition)
        original = json.loads(self.manifest().read_text(encoding="utf-8"))
        for field, value in (
            ("endpoint", "https://evil.example.net/collect"),
            ("credential_refs", [{"source": "env", "name": "OTHER_API_KEY"}]),
        ):
            with self.subTest(field=field):
                payload = copy.deepcopy(original)
                payload["approvals"][definition["id"]][field] = value
                self.manifest().write_text(json.dumps(payload), encoding="utf-8")
                trust, reason = backend._definition_trust(definition)
                self.assertEqual(trust, "blocked")
                self.assertIn("match", reason)

    def test_corrupt_approval_manifest_blocks_profile_but_not_bundled(self):
        definition = self.profile_definition()
        self.manifest().parent.mkdir(parents=True, exist_ok=True)
        self.manifest().write_text("{not json", encoding="utf-8")
        trust, reason = backend._definition_trust(definition)
        self.assertEqual(trust, "blocked")
        self.assertIn("could not be read", reason)
        loaded = backend._load_provider_definitions()
        prepared = backend._prepare_definitions(loaded)
        catalog = backend._definition_catalog(loaded, rows={}, prepared=prepared, profile="default")
        by_id = {entry["id"]: entry for entry in catalog["definitions"]}
        self.assertEqual(by_id["github-rate-limit"]["state"], "ready")
        self.assertEqual(by_id["moonshot-balance"]["state"], "available")

    def test_approval_preview_and_write_never_read_secrets(self):
        definition = self.profile_definition()
        with mock.patch.object(
            backend, "_read_definition_secret", side_effect=AssertionError("approval must not read secrets")
        ):
            preview = backend._definition_approval_preview(definition)
            self.approve(definition)
        self.assertEqual(preview["endpoint"], "https://api.example.com/v1/usage")
        self.assertEqual(preview["credential_labels"], ["EXAMPLE_API_KEY"])
        self.assertTrue(self.manifest().exists())

    def test_cli_requires_typed_confirmation(self):
        source = self.defs / "cli-definition.json"
        source.write_text(json.dumps(base_definition(id="cli-definition")), encoding="utf-8")
        script = ROOT / "scripts" / "approve_definition.py"
        env = {**os.environ, "HERMES_HOME": str(self.home)}

        refused = subprocess.run(
            [sys.executable, str(script), str(source)],
            input="no\n",
            text=True,
            capture_output=True,
            env=env,
            cwd=str(ROOT),
        )
        self.assertEqual(refused.returncode, 1, refused.stderr)
        self.assertFalse(self.manifest().exists())
        self.assertIn("Destination", refused.stdout)
        self.assertIn("EXAMPLE_API_KEY", refused.stdout)

        approved = subprocess.run(
            [sys.executable, str(script), str(source)],
            input="approve\n",
            text=True,
            capture_output=True,
            env={**env, "EXAMPLE_API_KEY": "synthetic-do-not-print"},
            cwd=str(ROOT),
        )
        self.assertEqual(approved.returncode, 0, approved.stderr)
        self.assertIn("approved cli-definition", approved.stdout)
        self.assertNotIn("synthetic-do-not-print", approved.stdout + approved.stderr)
        payload = json.loads(self.manifest().read_text(encoding="utf-8"))
        entry = payload["approvals"]["cli-definition"]
        self.assertEqual(entry["endpoint"], "https://api.example.com/v1/usage")
        self.assertEqual(entry["credential_refs"], [{"source": "env", "name": "EXAMPLE_API_KEY"}])
        self.assertNotEqual(self.manifest().parent, self.defs)
        self.assertNotIn("synthetic-do-not-print", self.manifest().read_text(encoding="utf-8"))

    def test_profile_isolation_scopes_approval_and_cache(self):
        definition = self.profile_definition()
        self.approve(definition)
        self.assertEqual(backend._definition_trust(definition)[0], "approved")
        scope_a = backend._hermes_home_scope()

        other_home = Path(self.temp.name) / "other-home"
        other_home.mkdir()
        os.environ["HERMES_HOME"] = str(other_home)
        try:
            self.assertEqual(backend._definition_trust(definition)[0], "untrusted")
            requests = []
            with mock.patch.object(
                backend, "_read_definition_secret", side_effect=AssertionError("cross-profile secret read")
            ):
                row = backend._fetch_declarative_cached(
                    definition,
                    profile="default",
                    transport=httpx.MockTransport(lambda request: requests.append(request) or httpx.Response(200, json={})),
                )
            self.assertEqual(row["state"], "requires_approval")
            self.assertEqual(requests, [])

            self.approve(definition, home=other_home)
            headers = {"Authorization": "Bearer synthetic-test-value"}
            handler = lambda request: httpx.Response(200, json={"usage": {"used": 1, "limit": 2}}, headers={"content-type": "application/json"})
            row_other = backend._fetch_declarative_cached(
                definition, profile="default", headers=headers, transport=httpx.MockTransport(handler)
            )
            self.assertEqual(row_other["provenance"]["cache"], "miss")
            scope_b = backend._hermes_home_scope()
            self.assertNotEqual(scope_a, scope_b)
            self.assertEqual(row_other["provenance"]["scope"], scope_b)
            self.assertNotIn(row_other["provenance"]["scope"], {"active", "default"})
        finally:
            os.environ["HERMES_HOME"] = str(self.home)

    def test_cache_does_not_serve_home_a_row_to_home_b(self):
        definition = self.profile_definition()
        self.approve(definition)
        headers = {"Authorization": "Bearer synthetic-test-value"}
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(200, json={"usage": {"used": 1, "limit": 2}}, headers={"content-type": "application/json"})

        first = backend._fetch_declarative_cached(
            definition, profile="default", headers=headers, transport=httpx.MockTransport(handler)
        )
        self.assertEqual(first["provenance"]["cache"], "miss")

        other_home = Path(self.temp.name) / "cache-home-b"
        other_home.mkdir()
        os.environ["HERMES_HOME"] = str(other_home)
        try:
            self.approve(definition, home=other_home)
            second = backend._fetch_declarative_cached(
                definition, profile="default", headers=headers, transport=httpx.MockTransport(handler)
            )
            self.assertEqual(second["provenance"]["cache"], "miss")
            self.assertEqual(len(calls), 2)
            self.assertNotEqual(first["provenance"]["scope"], second["provenance"]["scope"])
        finally:
            os.environ["HERMES_HOME"] = str(self.home)


class FetchTests(IsolatedHome):
    def setUp(self):
        super().setUp()
        definition, errors, _ = validate(base_definition())
        self.assertEqual(errors, [])
        self.definition = definition
        self.approve(self.definition)
        self.dns = mock.patch.object(backend.socket, "getaddrinfo", side_effect=public_dns)
        self.dns.start()
        self.addCleanup(self.dns.stop)
        self.requests = []

    def transport(self, handler):
        def wrapped(request):
            self.requests.append(request)
            return handler(request)
        return httpx.MockTransport(wrapped)

    def test_fetch_sets_auth_and_normalizes(self):
        def handler(request):
            self.assertEqual(request.headers.get("authorization"), "Bearer synthetic-test-value")
            self.assertEqual(request.headers.get("accept"), "application/json")
            self.assertEqual(request.headers.get("host"), "api.example.com")
            return httpx.Response(200, json={"plan": "Pro", "usage": {"used": 5, "limit": 10, "reset": 1800000000}, "account": {"name": "Sample"}}, headers={"content-type": "application/json"})
        with mock.patch.dict(os.environ, {"EXAMPLE_API_KEY": "synthetic-test-value"}):
            row = backend._fetch_declarative_cached(self.definition, profile="default", transport=self.transport(handler))
        self.assertEqual(row["state"], "ok")
        self.assertEqual(row["provenance"]["cache"], "miss")
        self.assertEqual(row["limits"][0]["windows"][0]["remaining_percent"], 50.0)
        self.assertTrue(row["provenance"]["scope"].startswith("home:"))

    def test_request_targets_pinned_ip_and_preserves_tls_name(self):
        def handler(request):
            self.assertEqual(request.url.host, "93.184.216.34")
            self.assertEqual(request.headers.get("host"), "api.example.com")
            self.assertEqual(request.extensions.get("sni_hostname"), "api.example.com")
            return httpx.Response(200, json={"plan": "Pro", "usage": {"used": 5, "limit": 10}}, headers={"content-type": "application/json"})
        with mock.patch.dict(os.environ, {"EXAMPLE_API_KEY": "synthetic-test-value"}):
            row = backend._fetch_declarative_cached(self.definition, profile="default", transport=self.transport(handler))
        self.assertEqual(row["state"], "ok")
        self.assertEqual(len(self.requests), 1)
        args, kwargs = backend.socket.getaddrinfo.call_args
        self.assertEqual(args[0], "api.example.com")
        self.assertEqual(kwargs.get("type"), socket.SOCK_STREAM)

    def test_real_transport_dials_the_pinned_ip_not_the_hostname(self):
        dials = []

        def stop_at_dial(address, *args, **kwargs):
            dials.append(address)
            raise OSError("synthetic dial stop")

        with mock.patch.object(backend.socket, "create_connection", side_effect=stop_at_dial):
            row = backend._fetch_declarative_cached(
                self.definition,
                profile="default",
                headers={"Authorization": "Bearer synthetic-test-value"},
            )
        self.assertEqual(row["state"], "unavailable")
        self.assertTrue(dials)
        self.assertEqual(dials[0], ("93.184.216.34", 443))

    def test_cache_hit_does_not_refetch(self):
        def handler(request):
            return httpx.Response(200, json={"plan": "Pro", "usage": {"used": 5, "limit": 10}}, headers={"content-type": "application/json"})
        with mock.patch.dict(os.environ, {"EXAMPLE_API_KEY": "synthetic-test-value"}):
            backend._fetch_declarative_cached(self.definition, profile="default", transport=self.transport(handler))
            row = backend._fetch_declarative_cached(self.definition, profile="default", transport=self.transport(handler))
        self.assertEqual(row["provenance"]["cache"], "hit")
        self.assertEqual(len(self.requests), 1)

    def test_missing_credential_is_not_connected(self):
        with mock.patch.dict(os.environ, {"EXAMPLE_API_KEY": ""}):
            row = backend._fetch_declarative_cached(self.definition, profile="default")
        self.assertEqual(row["state"], "not_connected")
        self.assertIn("EXAMPLE_API_KEY", row["unavailable_reason"])
        self.assertFalse(row["available"])
        self.assertEqual(row["provenance"]["cache"], "none")
        self.assertIsNone(row["freshness"]["fetched_at"])
        self.assertIsNone(row["freshness"]["age_seconds"])

    def test_401_and_403_need_permission(self):
        for status in (401, 403):
            with self.subTest(status=status):
                row = backend._fetch_declarative_cached(
                    self.definition,
                    profile="default",
                    headers={"Authorization": "Bearer synthetic-test-value"},
                    transport=self.transport(lambda request, status=status: httpx.Response(status, json={"error": "nope"})),
                )
                self.assertEqual(row["state"], "needs_permission")

    def test_redirect_is_refused_without_forwarding(self):
        with mock.patch.dict(os.environ, {"EXAMPLE_API_KEY": "synthetic-test-value"}):
            row = backend._fetch_declarative_cached(
                self.definition,
                profile="default",
                transport=self.transport(lambda request: httpx.Response(302, headers={"location": "https://evil.example.com/steal"})),
            )
        self.assertEqual(row["state"], "unavailable")
        self.assertIn("redirects are not followed", row["unavailable_reason"].lower())
        self.assertEqual(len(self.requests), 1)

    def test_private_dns_is_blocked_before_request(self):
        with mock.patch.object(backend.socket, "getaddrinfo", side_effect=private_dns):
            row = backend._fetch_declarative_cached(
                self.definition,
                profile="default",
                headers={"Authorization": "Bearer synthetic-test-value"},
                transport=self.transport(lambda request: httpx.Response(200, json={})),
            )
        self.assertEqual(row["state"], "blocked")
        self.assertEqual(self.requests, [])

    def test_reserved_nat64_and_mapped_addresses_are_blocked(self):
        for address in ("10.0.0.1", "224.0.0.1", "2001:db8::1", "64:ff9b::5db8:d822", "::ffff:127.0.0.1"):
            with self.subTest(address=address):
                def dns(*_args, address=address, **_kwargs):
                    return [(socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443, 0, 0))]

                with mock.patch.object(backend.socket, "getaddrinfo", side_effect=dns):
                    row = backend._fetch_declarative_cached(
                        self.definition,
                        profile="default",
                        headers={"Authorization": "Bearer synthetic-test-value"},
                        transport=self.transport(lambda request: httpx.Response(200, json={})),
                    )
                self.assertEqual(row["state"], "blocked")
        self.assertEqual(self.requests, [])

    def test_dns_lookup_is_wall_clock_bounded(self):
        def slow_dns(*_args, **_kwargs):
            time.sleep(0.5)
            return public_dns()

        with mock.patch.object(backend, "_DEFINITION_DNS_TIMEOUT_SECS", 0.05), mock.patch.object(
            backend.socket, "getaddrinfo", side_effect=slow_dns
        ):
            row = backend._fetch_declarative_cached(
                self.definition,
                profile="default",
                headers={"Authorization": "Bearer synthetic-test-value"},
                transport=self.transport(lambda request: httpx.Response(200, json={})),
            )
        self.assertEqual(row["state"], "unavailable")
        self.assertIn("did not finish", row["unavailable_reason"])
        self.assertEqual(self.requests, [])

    def test_total_deadline_covers_a_slow_response(self):
        def slow_response(request):
            time.sleep(0.2)
            return httpx.Response(200, json={"usage": {"used": 1, "limit": 2}}, headers={"content-type": "application/json"})

        with mock.patch.object(backend, "_DEFINITION_TOTAL_TIMEOUT_SECS", 0.05):
            row = backend._fetch_declarative_cached(
                self.definition,
                profile="default",
                headers={"Authorization": "Bearer synthetic-test-value"},
                transport=self.transport(slow_response),
            )
        self.assertEqual(row["state"], "unavailable")
        self.assertIn("total deadline", row["unavailable_reason"])

    def test_oversized_response_is_rejected(self):
        row = backend._fetch_declarative_cached(
            self.definition,
            profile="default",
            headers={"Authorization": "Bearer synthetic-test-value"},
            transport=self.transport(lambda request: httpx.Response(200, content=b"x" * (backend._DEFINITION_MAX_BYTES + 1), headers={"content-type": "application/json"})),
        )
        self.assertEqual(row["state"], "unavailable")
        self.assertIn("larger than", row["unavailable_reason"])

    def test_non_json_is_rejected(self):
        row = backend._fetch_declarative_cached(
            self.definition,
            profile="default",
            headers={"Authorization": "Bearer synthetic-test-value"},
            transport=self.transport(lambda request: httpx.Response(200, content=b"<html>", headers={"content-type": "text/html"})),
        )
        self.assertEqual(row["state"], "unavailable")
        self.assertIn("did not return JSON", row["unavailable_reason"])

    def test_stale_cache_does_not_mask_a_new_security_block(self):
        calls = {"count": 0}

        def handler(request):
            calls["count"] += 1
            return httpx.Response(200, json={"plan": "Pro", "usage": {"used": 5, "limit": 10}}, headers={"content-type": "application/json"})

        with mock.patch.dict(os.environ, {"EXAMPLE_API_KEY": "synthetic-test-value"}):
            first = backend._fetch_declarative_cached(self.definition, profile="default", transport=self.transport(handler))
            with backend._DEFINITION_CACHE_LOCK:
                for entry in backend._DEFINITION_CACHE.values():
                    entry["at"] = 0
            with mock.patch.object(backend.socket, "getaddrinfo", side_effect=private_dns):
                blocked = backend._fetch_declarative_cached(
                    self.definition,
                    profile="default",
                    transport=self.transport(lambda request: httpx.Response(200, json={})),
                )
        self.assertEqual(first["state"], "ok")
        self.assertEqual(blocked["state"], "blocked")
        self.assertNotEqual(blocked["state"], "stale")
        self.assertEqual(blocked["trust"], "approved")
        self.assertEqual(calls["count"], 1)

    def test_cache_is_scoped_to_profile_within_one_home(self):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(200, json={"plan": "Pro", "usage": {"used": 5, "limit": 10}}, headers={"content-type": "application/json"})

        headers = {"Authorization": "Bearer synthetic-test-value"}
        first = backend._fetch_declarative_cached(
            self.definition, profile="default", headers=headers, transport=self.transport(handler)
        )
        second = backend._fetch_declarative_cached(
            self.definition, profile="work", headers=headers, transport=self.transport(handler)
        )
        self.assertEqual(first["provenance"]["cache"], "miss")
        self.assertEqual(second["provenance"]["cache"], "miss")
        self.assertEqual(len(calls), 2)
        self.assertEqual(first["provenance"]["scope"], second["provenance"]["scope"])
        self.assertEqual(first["provenance"]["profile"], "default")
        self.assertEqual(second["provenance"]["profile"], "work")

    def test_stale_cache_is_labelled(self):
        calls = {"count": 0}
        def handler(request):
            calls["count"] += 1
            if calls["count"] == 1:
                return httpx.Response(200, json={"plan": "Pro", "usage": {"used": 5, "limit": 10}}, headers={"content-type": "application/json"})
            return httpx.Response(500)
        with mock.patch.dict(os.environ, {"EXAMPLE_API_KEY": "synthetic-test-value"}):
            first = backend._fetch_declarative_cached(self.definition, profile="default", transport=self.transport(handler))
            with backend._DEFINITION_CACHE_LOCK:
                for entry in backend._DEFINITION_CACHE.values():
                    entry["at"] = 0
            row = backend._fetch_declarative_cached(self.definition, profile="default", transport=self.transport(handler))
        self.assertEqual(first["state"], "ok")
        self.assertEqual(row["state"], "stale")
        self.assertTrue(row["freshness"]["stale"])
        self.assertEqual(row["provenance"]["cache"], "stale")
        self.assertIn("HTTP 500", row["provenance"]["error"])


class OverviewIntegrationTests(IsolatedHome):
    def test_overview_merges_declarative_rows_and_catalog(self):
        def handler(request):
            if str(request.url.path) == "/rate_limit":
                return httpx.Response(200, json={
                    "resources": {
                        "core": {"limit": 60, "used": 5, "remaining": 55, "reset": 1800000000},
                        "search": {"limit": 10, "used": 0, "remaining": 10, "reset": 1800000000},
                        "graphql": {"limit": 0, "used": 0, "remaining": 0, "reset": 1800000000},
                    },
                    "rate": {"rate": "unauthenticated"},
                }, headers={"content-type": "application/json"})
            return httpx.Response(200, json={"plan": "Pro", "usage": {"used": 1, "limit": 2}}, headers={"content-type": "application/json"})

        with mock.patch.object(backend.socket, "getaddrinfo", side_effect=public_dns), \
             mock.patch.object(backend, "_inventory", return_value=[]), \
             mock.patch.object(backend, "_maybe_refresh_vendor_specs", return_value=None), \
             mock.patch.object(backend, "_refresh_vendor_specs", return_value=None), \
             mock.patch.object(backend, "_cache_stats", return_value={}), \
             mock.patch.object(backend, "_pricing_rows", return_value=[]), \
             mock.patch.object(backend, "_peak_state", return_value=None):
            backend._DEFINITION_TRANSPORT = httpx.MockTransport(handler)
            try:
                data = backend._overview_scoped({}, None)
            finally:
                backend._DEFINITION_TRANSPORT = None
        self.assertEqual(data["account_profile"], "default")
        by_id = {row["id"]: row for row in data["providers"]}
        self.assertIn("github-rate-limit", by_id)
        self.assertNotIn("moonshot-balance", by_id)  # not connected -> catalog only
        self.assertEqual(by_id["github-rate-limit"]["state"], "ok")
        catalog = {entry["id"]: entry for entry in data["catalog"]["definitions"]}
        self.assertEqual(catalog["github-rate-limit"]["state"], "connected")
        self.assertEqual(catalog["moonshot-balance"]["state"], "available")
        self.assertIn("MOONSHOT_API_KEY", catalog["moonshot-balance"]["missing_credentials"])
        serialized = json.dumps(data)
        self.assertNotIn("synthetic-test-value", serialized)
        self.assertNotIn("Bearer ", serialized)

    def test_overview_never_fetches_untrusted_profile_definition(self):
        raw = base_definition(id="evil-usage")
        raw["request"]["url"] = "https://evil.example.net/collect"
        raw["request"]["hosts"] = ["evil.example.net"]
        self.write("evil.json", raw)
        paths = []
        secret_reads = []

        def dns(host, *_args, **_kwargs):
            address = "93.184.216.34" if host == "api.github.com" else "8.8.8.8"
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]

        def handler(request):
            paths.append(str(request.url))
            return httpx.Response(200, json={
                "resources": {
                    "core": {"limit": 60, "used": 1, "remaining": 59, "reset": 1800000000},
                    "search": {"limit": 10, "used": 0, "remaining": 10, "reset": 1800000000},
                    "graphql": {"limit": 0, "used": 0, "remaining": 0, "reset": 1800000000},
                },
                "rate": {"rate": "unauthenticated"},
            }, headers={"content-type": "application/json"})

        def secret(name):
            secret_reads.append(name)
            return None

        with mock.patch.object(backend.socket, "getaddrinfo", side_effect=dns), \
             mock.patch.object(backend, "_read_definition_secret", side_effect=secret), \
             mock.patch.object(backend, "_inventory", return_value=[]), \
             mock.patch.object(backend, "_maybe_refresh_vendor_specs", return_value=None), \
             mock.patch.object(backend, "_refresh_vendor_specs", return_value=None), \
             mock.patch.object(backend, "_cache_stats", return_value={}), \
             mock.patch.object(backend, "_pricing_rows", return_value=[]), \
             mock.patch.object(backend, "_peak_state", return_value=None):
            backend._DEFINITION_TRANSPORT = httpx.MockTransport(handler)
            try:
                data = backend._overview_scoped({}, None)
            finally:
                backend._DEFINITION_TRANSPORT = None

        self.assertTrue(any("/rate_limit" in path for path in paths))
        self.assertFalse(any("/collect" in path for path in paths), paths)
        self.assertNotIn("EXAMPLE_API_KEY", secret_reads)
        catalog = {entry["id"]: entry for entry in data["catalog"]["definitions"]}
        self.assertEqual(catalog["evil-usage"]["state"], "requires_approval")
        self.assertNotIn("evil-usage", {row["id"] for row in data["providers"]})


class ValidatorCliTests(IsolatedHome):
    def test_bundled_and_profile_report_correct_approval_requirement(self):
        source = self.defs / "custom.json"
        source.write_text(json.dumps(base_definition(id="custom-one")), encoding="utf-8")
        script = ROOT / "scripts" / "validate_definition.py"
        bundled = subprocess.run(
            [sys.executable, str(script), str(ROOT / "dashboard" / "definitions" / "catalog" / "github-rate-limit.json"), "--json"],
            text=True,
            capture_output=True,
            cwd=str(ROOT),
        )
        self.assertEqual(bundled.returncode, 0, bundled.stderr)
        bundled_result = json.loads(bundled.stdout)["results"][0]
        self.assertTrue(bundled_result["ok"])
        self.assertFalse(bundled_result["requires_approval"])

        profile = subprocess.run(
            [sys.executable, str(script), str(source), "--json"],
            text=True,
            capture_output=True,
            cwd=str(ROOT),
        )
        self.assertEqual(profile.returncode, 0, profile.stderr)
        profile_result = json.loads(profile.stdout)["results"][0]
        self.assertTrue(profile_result["ok"])
        self.assertTrue(profile_result["requires_approval"])
        self.assertEqual(profile_result["credential_refs"], [{"source": "env", "name": "EXAMPLE_API_KEY"}])


class PackagingTests(IsolatedHome):
    def run_packager(self, definition_path, outdir):
        return subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "package-definition.py"), str(definition_path), "--out", str(outdir)],
            text=True,
            capture_output=True,
            env={**os.environ, "HERMES_HOME": str(self.home)},
            cwd=str(ROOT),
        )

    def test_package_has_structured_refs_and_no_approval(self):
        source = self.defs / "contrib.json"
        source.write_text(json.dumps(base_definition(id="contrib-usage")), encoding="utf-8")
        out = Path(self.temp.name) / "out"
        result = self.run_packager(source, out)
        self.assertEqual(result.returncode, 0, result.stderr)
        package = out / "contrib-usage"
        self.assertTrue((package / "definition.json").exists())
        manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["credential_refs"], [{"source": "env", "name": "EXAMPLE_API_KEY"}])
        self.assertEqual(manifest["credential_labels"], ["EXAMPLE_API_KEY"])
        self.assertEqual(manifest["approval"]["required"], True)
        self.assertEqual(manifest["approval"]["approved"], False)
        self.assertEqual(manifest["approval"]["included"], False)
        self.assertFalse(any("approval" in path.name.lower() for path in package.iterdir()))
        readme = (package / "README.md").read_text(encoding="utf-8")
        self.assertIn("Packaging is not approval", readme)
        self.assertIn("approve_definition.py", readme)
        self.assertFalse(self.manifest().exists())

    def test_package_manifest_is_reproducible(self):
        source = self.defs / "contrib.json"
        source.write_text(json.dumps(base_definition(id="contrib-usage")), encoding="utf-8")
        out = Path(self.temp.name) / "out"
        first = self.run_packager(source, out)
        self.assertEqual(first.returncode, 0, first.stderr)
        manifest_path = out / "contrib-usage" / "manifest.json"
        first_manifest = manifest_path.read_bytes()
        time.sleep(1.05)  # a wall-clock stamp at second resolution would change here
        second = self.run_packager(source, out)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(manifest_path.read_bytes(), first_manifest)
        self.assertNotIn("generated_at", json.loads(first_manifest))
        self.assertEqual(first.stdout, second.stdout)

    def test_package_refuses_approval_manifest_input(self):
        approvals = self.defs / "approvals.json"
        approvals.write_text(json.dumps({"schema": backend._DEFINITION_APPROVAL_SCHEMA, "approvals": {}}), encoding="utf-8")
        result = self.run_packager(approvals, Path(self.temp.name) / "out")
        self.assertEqual(result.returncode, 1)
        self.assertIn("refusing to package an approval", result.stderr)

    def test_package_removes_stale_approval_artifact(self):
        source = self.defs / "contrib.json"
        source.write_text(json.dumps(base_definition(id="contrib-usage")), encoding="utf-8")
        out = Path(self.temp.name) / "out"
        package = out / "contrib-usage"
        package.mkdir(parents=True)
        stale = package / "approvals.json"
        stale.write_text("{}", encoding="utf-8")
        result = self.run_packager(source, out)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(stale.exists())


if __name__ == "__main__":
    unittest.main()
