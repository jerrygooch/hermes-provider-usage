"""Schema, SSRF, cache, mapping, and catalog tests for declarative providers.

Run with:
    python -m unittest tests.test_declarative_definitions -v
"""

import copy
import importlib.util
import json
import os
import socket
import sys
import tempfile
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
        self.assertEqual(definition["mapping"]["windows"][0]["unit"], "requests")

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
        raw["request"]["headers"] = {"Authorization": "Bearer sk-live-secret"}
        self.assert_error(raw, "must be a list")

    def test_credential_must_be_reference(self):
        raw = base_definition()
        raw["request"]["headers"][0]["credential"] = {"source": "env", "name": "EXAMPLE_API_KEY", "value": "sk-secret"}
        self.assert_error(raw, "unknown key")

    def test_credential_source_rejected(self):
        raw = base_definition()
        raw["request"]["headers"][0]["credential"] = {"source": "file", "name": "EXAMPLE_API_KEY"}
        self.assert_error(raw, "must be env or hermes_provider")

    def test_unknown_keys_rejected(self):
        raw = base_definition(script="fetch('https://evil')")
        self.assert_error(raw, "unknown key")
        raw = base_definition()
        raw["mapping"]["eval"] = "x"
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


class HttpRouteTests(unittest.TestCase):
    def setUp(self):
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

        raw = base_definition()
        response = self.client.post(
            "/api/plugins/provider-usage/definitions/validate",
            json={"definition": raw},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])
        self.assertEqual(response.json()["summary"]["host"], "api.example.com")


class ValidateRouteTests(unittest.TestCase):
    def test_valid_json_returns_summary_without_network(self):
        result = backend.definitions_validate({"json": json.dumps(base_definition())})
        self.assertTrue(result["ok"])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["summary"]["host"], "api.example.com")
        self.assertEqual(result["summary"]["windows"], 1)
        self.assertEqual(result["summary"]["credential_refs"], ["EXAMPLE_API_KEY"])

    def test_invalid_json_returns_actionable_errors(self):
        result = backend.definitions_validate({"json": "{not json"})
        self.assertFalse(result["ok"])
        self.assertTrue(result["errors"][0].startswith("json:"))
        self.assertIsNone(result["summary"])

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


class LoadingAndCollisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.env = mock.patch.dict(os.environ, {"HERMES_PROVIDER_USAGE_DEFINITIONS": str(self.dir)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_catalog_endpoint_does_not_claim_connected_without_rows(self):
        loaded = backend._load_provider_definitions()
        prepared = backend._prepare_definitions(loaded)
        catalog = backend._definition_catalog(loaded, rows={}, prepared=prepared, profile="default")
        by_id = {entry["id"]: entry for entry in catalog["definitions"]}
        self.assertEqual(by_id["github-rate-limit"]["state"], "ready")
        self.assertEqual(by_id["moonshot-balance"]["state"], "available")
        self.assertIn("MOONSHOT_API_KEY", by_id["moonshot-balance"]["missing_credentials"])

    def write(self, name, payload):
        (self.dir / name).write_text(json.dumps(payload), encoding="utf-8")

    def test_bundled_catalog_loads(self):
        loaded = backend._load_provider_definitions()
        self.assertIn("github-rate-limit", loaded["valid"])
        self.assertIn("moonshot-balance", loaded["valid"])
        self.assertIn("elevenlabs-subscription", loaded["valid"])
        self.assertEqual(loaded["invalid"], [])

    def test_custom_collision_requires_explicit_override(self):
        custom = base_definition(id="moonshot-balance")
        self.write("collision.json", custom)
        loaded = backend._load_provider_definitions()
        # The bundled copy still wins and the custom entry is reported invalid.
        invalid = [entry for entry in loaded["invalid"] if entry["file"] == "collision.json"]
        self.assertEqual(len(invalid), 1)
        self.assertIn("collides with bundled definition", invalid[0]["errors"][0])
        self.assertEqual(loaded["valid"]["moonshot-balance"]["definition"]["_source"], "bundled")

    def test_custom_override_replaces_bundled(self):
        custom = base_definition(id="moonshot-balance", override=True, name="Moonshot custom")
        self.write("override.json", custom)
        loaded = backend._load_provider_definitions()
        self.assertEqual(loaded["valid"]["moonshot-balance"]["definition"]["_source"], "profile")
        self.assertEqual(loaded["valid"]["moonshot-balance"]["definition"]["_overrides"], "bundled")
        self.assertNotIn("override.json", [entry["file"] for entry in loaded["invalid"]])

    def test_duplicate_profile_id_first_wins(self):
        self.write("a.json", base_definition(id="custom-one"))
        self.write("b.json", base_definition(id="custom-one"))
        loaded = backend._load_provider_definitions()
        self.assertEqual(loaded["valid"]["custom-one"]["file"], "a.json")
        invalid = [entry for entry in loaded["invalid"] if entry["file"] == "b.json"]
        self.assertEqual(len(invalid), 1)
        self.assertIn("duplicate profile definition", invalid[0]["errors"][0])

    def test_invalid_file_does_not_break_other_definitions(self):
        (self.dir / "broken.json").write_text("{not json", encoding="utf-8")
        self.write("good.json", base_definition(id="custom-good"))
        loaded = backend._load_provider_definitions()
        self.assertIn("custom-good", loaded["valid"])
        self.assertTrue(any(entry["file"] == "broken.json" for entry in loaded["invalid"]))


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


class FetchTests(unittest.TestCase):
    def setUp(self):
        backend._DEFINITION_CACHE.clear()
        self.definition = validate(base_definition())[0]
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
            self.assertEqual(request.headers.get("authorization"), "Bearer test-value")
            self.assertEqual(request.headers.get("accept"), "application/json")
            return httpx.Response(200, json={"plan": "Pro", "usage": {"used": 5, "limit": 10, "reset": 1800000000}, "account": {"name": "Sample"}}, headers={"content-type": "application/json"})
        with mock.patch.dict(os.environ, {"EXAMPLE_API_KEY": "test-value"}):
            row = backend._fetch_declarative_cached(self.definition, profile="default", transport=self.transport(handler))
        self.assertEqual(row["state"], "ok")
        self.assertEqual(row["provenance"]["cache"], "miss")
        self.assertEqual(row["limits"][0]["windows"][0]["remaining_percent"], 50.0)

    def test_cache_hit_does_not_refetch(self):
        def handler(request):
            return httpx.Response(200, json={"plan": "Pro", "usage": {"used": 5, "limit": 10}}, headers={"content-type": "application/json"})
        with mock.patch.dict(os.environ, {"EXAMPLE_API_KEY": "test-value"}):
            backend._fetch_declarative_cached(self.definition, profile="default", transport=self.transport(handler))
            row = backend._fetch_declarative_cached(self.definition, profile="default", transport=self.transport(handler))
        self.assertEqual(row["provenance"]["cache"], "hit")
        self.assertEqual(len(self.requests), 1)

    def test_missing_credential_is_not_connected(self):
        with mock.patch.dict(os.environ, {}, clear=True):
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
                    headers={"Authorization": "Bearer test-value"},
                    transport=self.transport(lambda request, status=status: httpx.Response(status, json={"error": "nope"})),
                )
                self.assertEqual(row["state"], "needs_permission")

    def test_redirect_is_refused_without_forwarding(self):
        with mock.patch.dict(os.environ, {"EXAMPLE_API_KEY": "test-value"}):
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
                headers={"Authorization": "Bearer test-value"},
                transport=self.transport(lambda request: httpx.Response(200, json={})),
            )
        self.assertEqual(row["state"], "blocked")
        self.assertEqual(self.requests, [])

    def test_oversized_response_is_rejected(self):
        row = backend._fetch_declarative_cached(
            self.definition,
            profile="default",
            headers={"Authorization": "Bearer test-value"},
            transport=self.transport(lambda request: httpx.Response(200, content=b"x" * (backend._DEFINITION_MAX_BYTES + 1), headers={"content-type": "application/json"})),
        )
        self.assertEqual(row["state"], "unavailable")
        self.assertIn("larger than", row["unavailable_reason"])

    def test_non_json_is_rejected(self):
        row = backend._fetch_declarative_cached(
            self.definition,
            profile="default",
            headers={"Authorization": "Bearer test-value"},
            transport=self.transport(lambda request: httpx.Response(200, content=b"<html>", headers={"content-type": "text/html"})),
        )
        self.assertEqual(row["state"], "unavailable")
        self.assertIn("did not return JSON", row["unavailable_reason"])

    def test_stale_cache_is_labelled(self):
        calls = {"count": 0}
        def handler(request):
            calls["count"] += 1
            if calls["count"] == 1:
                return httpx.Response(200, json={"plan": "Pro", "usage": {"used": 5, "limit": 10}}, headers={"content-type": "application/json"})
            return httpx.Response(500)
        with mock.patch.dict(os.environ, {"EXAMPLE_API_KEY": "test-value"}):
            first = backend._fetch_declarative_cached(self.definition, profile="default", transport=self.transport(handler))
            # Expire the cache without waiting 60 seconds.
            with backend._DEFINITION_CACHE_LOCK:
                for entry in backend._DEFINITION_CACHE.values():
                    entry["at"] = 0
            row = backend._fetch_declarative_cached(self.definition, profile="default", transport=self.transport(handler))
        self.assertEqual(first["state"], "ok")
        self.assertEqual(row["state"], "stale")
        self.assertTrue(row["freshness"]["stale"])
        self.assertEqual(row["provenance"]["cache"], "stale")
        self.assertIn("HTTP 500", row["provenance"]["error"])


class OverviewIntegrationTests(unittest.TestCase):
    def setUp(self):
        backend._DEFINITION_CACHE.clear()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = mock.patch.dict(os.environ, {
            "HERMES_PROVIDER_USAGE_DEFINITIONS": self.temp.name,
            "EXAMPLE_API_KEY": "test-value",
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_overview_merges_declarative_rows_and_catalog(self):
        def handler(request):
            if "api.github.com" in str(request.url):
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
        self.assertNotIn("test-value", serialized)
        self.assertNotIn("Bearer ", serialized)


if __name__ == "__main__":
    unittest.main()
