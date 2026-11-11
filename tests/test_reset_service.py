"""Stock-seam contract tests for the bounded Codex banked-reset service.

No test redeems a real credit or reads a credential.  Unit tests use a duck-
typed core that deliberately exposes only the stock read/redeem methods, so an
accidental dependency on the unreleased inventory helpers fails immediately.
The integration class exercises the real stock ``agent.account_usage`` helpers
with only auth/transport patched.
"""

import contextlib
import importlib.util
import inspect
import os
import sys
import threading
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
RESET_PATH = ROOT / "dashboard" / "reset_service.py"
INTENT = "redeem_one_banked_codex_reset"
IDENTITY = "codex:acct-1:user-1"
OTHER = "codex:acct-2:user-2"
STOCK_CORE = Path(os.environ.get("HERMES_STOCK_CORE", "C:/Users/jerry/projects/provider-usage-stock-host"))
if STOCK_CORE.joinpath("agent", "account_usage.py").is_file():
    sys.path.insert(0, str(STOCK_CORE))


def load_reset_service():
    module_name = "provider_usage_reset_service_tests"
    spec = importlib.util.spec_from_file_location(module_name, RESET_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


reset_service = load_reset_service()


@dataclass
class FakeWindow:
    label: str = "Session"
    used_percent: float = 100.0
    reset_at: str = None
    scope: str = "account"


@dataclass
class FakeSnapshot:
    identity: str | None = IDENTITY
    raw: dict = field(default_factory=dict)
    windows: list = field(default_factory=list)


def make_snapshot(
    identity: str | None = IDENTITY,
    *,
    available=2,
    applicable=1,
    used=100.0,
    include_count=True,
    extra_raw=None,
):
    raw = dict(extra_raw or {})
    if include_count:
        raw["rate_limit_reset_credits"] = {"available_count": available}
        if applicable is not None:
            raw["rate_limit_reset_credits"]["applicable_available_count"] = applicable
    return FakeSnapshot(identity, raw, [FakeWindow(used_percent=used), FakeWindow("Weekly", 40.0)])


class FakeCore:
    """Stock-shaped core: only scope/read/redeem, never the enhanced helpers."""

    def __init__(self, *, identity=IDENTITY, available=2, applicable=1, used=100.0, snapshots=None):
        self.identity = identity
        self.available = available
        self.applicable = applicable
        self.used = used
        self.snapshots = list(snapshots) if snapshots is not None else None
        self.read_calls = 0
        self.redeem_calls = 0
        self.scope_calls = []
        self.supports = True
        self.after_redeem = None
        self.result = SimpleNamespace(status="reset", message="core message", available_count=available - 1, windows_reset=2)
        self.inventory_payload = None
        self.inventory_raises = False
        self.redeem_entered = threading.Event()
        self.redeem_release = threading.Event()
        self.block_redeem = False
        self.raise_on_read = False

    def scope(self, profile):
        self.scope_calls.append(profile)
        return contextlib.nullcontext()

    def read(self):
        if self.raise_on_read:
            raise RuntimeError("synthetic read failure")
        self.read_calls += 1
        if self.snapshots is not None:
            index = min(self.read_calls - 1, len(self.snapshots) - 1)
            return self.snapshots[index]
        return make_snapshot(self.identity, available=self.available, applicable=self.applicable, used=self.used)

    def redeem(self):
        self.redeem_calls += 1
        self.redeem_entered.set()
        if self.block_redeem and not self.redeem_release.wait(5.0):
            raise RuntimeError("test redemption was not released")
        if self.after_redeem:
            self.after_redeem(self)
        return self.result

    def supports_redemption(self):
        return self.supports

    def inventory(self):
        if self.inventory_raises:
            raise RuntimeError("synthetic inventory failure")
        return self.inventory_payload


def make_service(core, *, profile=None, identity=IDENTITY, session_id="session-1", store=None, clock=None, ttl=120):
    return reset_service.ResetService(
        profile=profile,
        identity_id=identity,
        session_id=session_id,
        core=core,
        store=store or reset_service.ResetConfirmationStore(),
        clock=clock or (lambda: 1000.0),
        ttl_seconds=ttl,
    )


def preview_token(core, **kwargs):
    service = make_service(core, **kwargs)
    preview = service.preview()
    return service, preview, (preview.get("confirmation") or {}).get("token")


class SummaryTests(unittest.TestCase):
    def test_summary_reads_active_account_and_reports_counts_without_redeeming(self):
        core = FakeCore()
        summary = make_service(core).summary()

        self.assertTrue(summary["ok"])
        self.assertEqual(summary["state"], "ready")
        self.assertEqual(summary["identity_id"], IDENTITY)
        self.assertEqual(summary["available_count"], 2)
        self.assertEqual(summary["applicable_count"], 1)
        self.assertEqual(core.read_calls, 1)
        self.assertEqual(core.redeem_calls, 0)
        self.assertNotIn("credential_source", summary)
        self.assertNotIn("pool_account_count", summary)

    def test_no_identity_refuses_reset_but_keeps_read_only_counts(self):
        core = FakeCore(identity=None)
        summary = make_service(core).summary()
        preview = make_service(core).preview()

        self.assertEqual(summary["state"], "account_unverified")
        self.assertEqual(summary["available_count"], 2)
        self.assertFalse(summary["reset_executable"])
        self.assertEqual(preview["state"], "account_unverified")
        self.assertEqual(core.redeem_calls, 0)

    def test_requested_identity_that_is_not_active_is_refused(self):
        core = FakeCore()
        summary = make_service(core, identity=OTHER).summary()
        preview = make_service(core, identity=OTHER).preview()

        self.assertEqual(summary["state"], "account_changed")
        self.assertEqual(summary["identity_id"], IDENTITY)
        self.assertFalse(summary["reset_executable"])
        self.assertEqual(preview["state"], "account_changed")
        self.assertEqual(core.redeem_calls, 0)

    def test_unknown_count_and_no_banked_reset_states(self):
        unknown = make_service(FakeCore()).summary()
        self.assertEqual(unknown["state"], "ready")

        core = FakeCore()
        core.used = 40.0
        core.applicable = 1
        preview = make_service(core).preview()
        self.assertEqual(preview["state"], "ready")  # core owns the early-redemption guard

        missing = make_snapshot(include_count=False)
        core = FakeCore(snapshots=[missing])
        self.assertEqual(make_service(core).summary()["state"], "count_unknown")

        core = FakeCore(available=0)
        self.assertEqual(make_service(core).summary()["state"], "no_banked_resets")

        core = FakeCore(applicable=0)
        self.assertEqual(make_service(core).summary()["state"], "not_applicable")

    def test_inventory_expiry_is_projected_without_promising_one_credit(self):
        core = FakeCore()
        core.inventory_payload = {
            "credits": [
                {
                    "id": "credit-1",
                    "reset_type": "codex_rate_limits",
                    "status": "available",
                    "granted_at": "2026-06-17T00:00:00Z",
                    "expires_at": "2026-07-17T00:00:00Z",
                    "title": "Full reset",
                    "description": "Reset your current usage limits",
                },
                {"id": "credit-2", "status": "available", "expires_at": None},
            ]
        }
        summary = make_service(core).summary()

        self.assertEqual(summary["inventory_source"], "reset_credits_api")
        self.assertEqual([entry["id"] for entry in summary["entries"]], ["credit-1", "credit-2"])
        self.assertEqual(summary["entries"][0]["expires_at"], "2026-07-17T00:00:00Z")
        self.assertIsNone(summary["entries"][1]["expires_at"])
        self.assertTrue(summary["expiration_reported"])
        self.assertIn("no single expiry is promised", summary["expiration_note"])
        self.assertIsNone(summary.get("expires_at"))

    def test_inventory_failure_keeps_authoritative_counts(self):
        core = FakeCore()
        core.inventory_raises = True
        summary = make_service(core).summary()

        self.assertEqual(summary["state"], "ready")
        self.assertEqual(summary["available_count"], 2)
        self.assertIsNone(summary["entries"])
        self.assertFalse(summary["expiration_reported"])
        self.assertEqual(summary["inventory_source"], "usage_summary")

    def test_missing_redeem_seam_disables_reset(self):
        core = FakeCore()
        core.supports = False
        summary = make_service(core).summary()
        preview = make_service(core).preview()

        self.assertEqual(summary["state"], "reset_unsupported")
        self.assertFalse(summary["reset_executable"])
        self.assertEqual(preview["state"], "reset_unsupported")
        self.assertEqual(core.redeem_calls, 0)

    def test_unrelated_profile_is_refused_before_read_or_redeem(self):
        core = FakeCore()
        with mock.patch("hermes_cli.web_server_profiles._is_other_profile", side_effect=lambda name: name == "other"):
            service = make_service(core, profile="other")
            self.assertEqual(service.summary()["state"], "profile_forbidden")
            self.assertEqual(service.preview()["state"], "profile_forbidden")
            self.assertEqual(service.confirm("token", confirmed_account=IDENTITY, confirmed_intent=INTENT)["reason"], "profile_forbidden")

        self.assertEqual(core.read_calls, 0)
        self.assertEqual(core.redeem_calls, 0)

    def test_read_failure_is_unavailable(self):
        core = FakeCore()
        core.raise_on_read = True
        summary = make_service(core).summary()

        self.assertEqual(summary["state"], "unavailable")
        self.assertFalse(summary["ok"])
        self.assertEqual(core.redeem_calls, 0)


class PreviewTests(unittest.TestCase):
    def test_preview_requires_session_and_exact_account(self):
        core = FakeCore()
        self.assertEqual(make_service(core, session_id="").preview()["state"], "session_unbound")
        self.assertEqual(make_service(core, identity=None).preview()["state"], "account_unselected")
        self.assertEqual(core.redeem_calls, 0)

    def test_preview_issues_120_second_single_use_token_without_redeeming(self):
        core = FakeCore()
        preview = make_service(core).preview()
        confirmation = preview["confirmation"]

        self.assertTrue(preview["ok"])
        self.assertTrue(confirmation["token"])
        self.assertEqual(confirmation["identity_id"], IDENTITY)
        self.assertEqual(confirmation["expires_in_seconds"], 120)
        self.assertEqual(confirmation["intent"], INTENT)
        self.assertFalse(confirmation["purchased_credit_used"])
        self.assertEqual(core.redeem_calls, 0)

    def test_preview_refuses_when_active_account_changed_after_summary_read(self):
        core = FakeCore(snapshots=[make_snapshot(IDENTITY), make_snapshot(OTHER)])
        service = make_service(core)
        service.summary()
        preview = service.preview()

        self.assertEqual(preview["state"], "account_changed")
        self.assertIsNone(preview["confirmation"])
        self.assertEqual(core.redeem_calls, 0)


class ConfirmTests(unittest.TestCase):
    def test_confirm_requires_exact_account_and_consumes_token_on_mismatch(self):
        core = FakeCore()
        service, preview, token = preview_token(core)

        refused = service.confirm(token, confirmed_account=OTHER, confirmed_intent=INTENT)
        self.assertEqual(refused["reason"], "account_mismatch")
        self.assertEqual(core.redeem_calls, 0)

        reused = service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)
        self.assertEqual(reused["status"], "invalid_or_used")
        self.assertEqual(core.redeem_calls, 0)

    def test_confirm_requires_same_session_and_unexpired_token(self):
        core = FakeCore()
        store = reset_service.ResetConfirmationStore()
        first = make_service(core, session_id="session-1", store=store)
        token = first.preview()["confirmation"]["token"]
        second = make_service(core, session_id="session-2", store=store)
        self.assertEqual(second.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)["reason"], "session_mismatch")

        now = [1000.0]
        service = make_service(core, clock=lambda: now[0], ttl=5)
        token = service.preview()["confirmation"]["token"]
        now[0] = 1006.0
        self.assertEqual(service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)["status"], "expired")
        self.assertEqual(core.redeem_calls, 0)

    def test_confirm_rechecks_identity_immediately_before_redeem(self):
        core = FakeCore(snapshots=[make_snapshot(IDENTITY), make_snapshot(OTHER)])
        service, preview, token = preview_token(core)

        result = service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)
        self.assertEqual(result["reason"], "account_changed")
        self.assertEqual(core.redeem_calls, 0)

    def test_confirm_refuses_when_identity_disappears_before_redeem(self):
        core = FakeCore(snapshots=[make_snapshot(IDENTITY), make_snapshot(None)])
        service, preview, token = preview_token(core)

        result = service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)
        self.assertEqual(result["reason"], "account_unverified")
        self.assertEqual(core.redeem_calls, 0)

    def test_confirm_refuses_when_availability_changed(self):
        core = FakeCore()
        service, preview, token = preview_token(core)
        core.available = 3

        result = service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)
        self.assertEqual(result["reason"], "availability_changed")
        self.assertEqual(core.redeem_calls, 0)

    def test_confirm_calls_core_once_and_reads_back(self):
        core = FakeCore()

        def after(c):
            c.available -= 1
            c.applicable = 0

        core.after_redeem = after
        service, preview, token = preview_token(core)

        result = service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)

        self.assertEqual(result["status"], "reset")
        self.assertTrue(result["ok"])
        self.assertEqual(result["credit_consumed"], "yes")
        self.assertFalse(result["purchased_credit_used"])
        self.assertEqual(result["available_before"], 2)
        self.assertEqual(result["available_after"], 1)
        self.assertEqual(result["windows_reset"], 2)
        self.assertTrue(result["readback"]["ok"])
        self.assertEqual(result["readback"]["identity_id"], IDENTITY)
        self.assertEqual(core.redeem_calls, 1)

    def test_confirmed_reset_requires_an_independent_same_identity_count_decrease(self):
        # Core says "reset" and predicts 1, but the independent readback still
        # reports 2. Core's prediction is never accepted as the readback.
        core = FakeCore(snapshots=[
            make_snapshot(available=2),
            make_snapshot(available=2),
            make_snapshot(available=2),
        ])
        service, preview, token = preview_token(core)

        result = service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)

        self.assertEqual(result["status"], "uncertain")
        self.assertFalse(result["ok"])
        self.assertEqual(result["credit_consumed"], "unknown")
        self.assertTrue(result["needs_reconcile"])
        self.assertEqual(result["available_after"], 2)
        self.assertEqual(result["available_before"], 2)
        self.assertEqual(core.redeem_calls, 1)

    def test_confirmed_reset_requires_a_readback_count_not_a_readback_error(self):
        core = FakeCore(snapshots=[
            make_snapshot(available=2),
            make_snapshot(available=2),
            None,
        ])
        service, preview, token = preview_token(core)

        result = service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)

        self.assertEqual(result["status"], "uncertain")
        self.assertFalse(result["ok"])
        self.assertEqual(result["credit_consumed"], "unknown")
        self.assertTrue(result["needs_reconcile"])
        self.assertIsNone(result["available_after"])
        self.assertEqual(core.redeem_calls, 1)

    def test_confirmed_reset_rejects_a_readback_from_a_different_identity(self):
        core = FakeCore(snapshots=[
            make_snapshot(available=2),
            make_snapshot(available=2),
            make_snapshot(OTHER, available=1),
        ])
        service, preview, token = preview_token(core)

        result = service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)

        self.assertEqual(result["status"], "uncertain")
        self.assertFalse(result["ok"])
        self.assertEqual(result["credit_consumed"], "unknown")
        self.assertTrue(result["needs_reconcile"])
        self.assertTrue(result["readback_mismatch"])
        self.assertEqual(result["available_after"], 1)
        self.assertEqual(core.redeem_calls, 1)

    def test_confirmed_reset_accepts_a_real_same_identity_decrease(self):
        core = FakeCore(snapshots=[
            make_snapshot(available=2),
            make_snapshot(available=2),
            make_snapshot(available=1),
        ])
        service, preview, token = preview_token(core)

        result = service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)

        self.assertEqual(result["status"], "reset")
        self.assertTrue(result["ok"])
        self.assertEqual(result["credit_consumed"], "yes")
        self.assertFalse(result["needs_reconcile"])
        self.assertEqual(result["available_after"], 1)
        self.assertEqual(core.redeem_calls, 1)

    def test_double_click_is_serialized_by_the_lock(self):
        core = FakeCore()
        core.block_redeem = True
        core.after_redeem = lambda c: setattr(c, "available", c.available - 1)
        service, preview, token = preview_token(core)
        first = {}

        def click():
            first.update(service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT))

        worker = threading.Thread(target=click)
        worker.start()
        self.assertTrue(core.redeem_entered.wait(2.0))
        second = service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)
        self.assertEqual(second["status"], "busy")
        core.redeem_release.set()
        worker.join(5.0)
        self.assertEqual(first["status"], "reset")
        self.assertEqual(core.redeem_calls, 1)

    def test_uncertain_result_is_never_retried_and_can_reconcile_from_decrease(self):
        core = FakeCore()
        core.result = SimpleNamespace(status="unavailable", message="timeout", available_count=2, windows_reset=0)
        service, preview, token = preview_token(core)
        result = service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)
        self.assertEqual(result["status"], "uncertain")
        self.assertEqual(result["credit_consumed"], "unknown")
        self.assertTrue(result["needs_reconcile"])
        self.assertEqual(core.redeem_calls, 1)

        core = FakeCore()
        core.result = SimpleNamespace(status="unavailable", message="timeout", available_count=1, windows_reset=0)
        core.after_redeem = lambda c: setattr(c, "available", c.available - 1)
        service, preview, token = preview_token(core)
        result = service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)
        self.assertEqual(result["status"], "uncertain")
        self.assertEqual(result["credit_consumed"], "yes")
        self.assertFalse(result["needs_reconcile"])

    def test_core_guard_refusal_keeps_credit(self):
        core = FakeCore()
        core.result = SimpleNamespace(status="not_exhausted", message="early", available_count=2, windows_reset=0)
        service, preview, token = preview_token(core)

        result = service.confirm(token, confirmed_account=IDENTITY, confirmed_intent=INTENT)
        self.assertEqual(result["status"], "refused")
        self.assertEqual(result["reason"], "not_exhausted")
        self.assertEqual(result["credit_consumed"], "no")
        self.assertEqual(core.redeem_calls, 1)


class StockCoreIntegrationTests(unittest.TestCase):
    """Real stock core helpers; only auth and HTTP transport are synthetic."""

    @classmethod
    def setUpClass(cls):
        try:
            import agent.account_usage as module
        except Exception as exc:
            raise unittest.SkipTest(f"stock core not importable: {type(exc).__name__}")
        if not Path(module.__file__).resolve().is_relative_to(STOCK_CORE.resolve()):
            raise unittest.SkipTest("loaded core is not the stock checkout")
        cls.au = module

    def _run(self, identity=IDENTITY):
        state = {"available": 1, "posts": 0}
        au = self.au

        class Response:
            status_code = 200

            def __init__(self, payload):
                self.payload = payload

            def raise_for_status(self):
                return None

            def json(self):
                return self.payload

        class Client:
            def __init__(self, *args, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def get(self, url, headers=None):
                return Response({
                    "plan_type": "plus",
                    "rate_limit": {"primary_window": {"used_percent": 100.0, "limit_window_seconds": 18000}},
                    "rate_limit_reset_credits": {"available_count": state["available"], "applicable_available_count": 1},
                })

            def post(self, url, headers=None, json=None):
                state["posts"] += 1
                state["available"] = max(0, state["available"] - 1)
                return Response({"code": "reset", "windows_reset": 2})

        patches = [
            mock.patch.object(au, "_resolve_codex_usage_credentials", return_value=("synthetic-token", "https://chatgpt.com/backend-api", None)),
            mock.patch.object(au, "_codex_headers", return_value={}),
            mock.patch.object(au, "_codex_snapshot_identity", side_effect=lambda token: identity),
            mock.patch.object(au, "_get_json", side_effect=lambda *args, **kwargs: {
                "plan_type": "plus",
                "rate_limit": {"primary_window": {"used_percent": 100.0, "limit_window_seconds": 18000}},
                "rate_limit_reset_credits": {"available_count": state["available"], "applicable_available_count": 1},
            }),
            mock.patch.object(au.httpx, "Client", Client),
            mock.patch("hermes_cli.web_server_profiles._config_profile_scope", return_value=contextlib.nullcontext()),
        ]
        return state, patches, au

    def test_real_stock_helpers_redeem_only_the_identity_they_read(self):
        state, patches, au = self._run()
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            core = reset_service.HermesCoreSeam()
            service = reset_service.ResetService(identity_id=IDENTITY, session_id="session-1", core=core)
            summary = service.summary()
            self.assertEqual(summary["state"], "ready")
            self.assertEqual(summary["identity_id"], IDENTITY)
            self.assertEqual(summary["available_count"], 1)
            preview = service.preview()
            self.assertEqual(preview["state"], "ready")
            result = service.confirm(
                preview["confirmation"]["token"], confirmed_account=IDENTITY, confirmed_intent=INTENT
            )

        self.assertEqual(result["status"], "reset")
        self.assertEqual(result["core_status"], "reset")
        self.assertEqual(result["available_after"], 0)
        self.assertEqual(state["posts"], 1)

    def test_real_stock_helpers_refuse_when_identity_is_missing(self):
        state, patches, au = self._run(identity=None)
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            service = reset_service.ResetService(identity_id=IDENTITY, session_id="s", core=reset_service.HermesCoreSeam())
            summary = service.summary()
            preview = service.preview()

        self.assertEqual(summary["state"], "account_unverified")
        self.assertEqual(preview["state"], "account_unverified")
        self.assertEqual(state["posts"], 0)

    def test_real_stock_helpers_refuse_a_different_requested_identity(self):
        state, patches, au = self._run()
        with contextlib.ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            service = reset_service.ResetService(identity_id=OTHER, session_id="s", core=reset_service.HermesCoreSeam())
            summary = service.summary()
            preview = service.preview()

        self.assertEqual(summary["state"], "account_changed")
        self.assertEqual(preview["state"], "account_changed")
        self.assertEqual(state["posts"], 0)


class ContractTests(unittest.TestCase):
    def test_confirm_signature_has_no_url_credit_or_force_knob(self):
        params = inspect.signature(reset_service.ResetService.confirm).parameters
        for forbidden in ("url", "credit_id", "force", "credit", "purchase"):
            self.assertNotIn(forbidden, params)
        self.assertEqual(list(inspect.signature(reset_service.HermesCoreSeam.redeem).parameters), ["self"])

    def test_module_has_no_credential_read_or_arbitrary_url(self):
        source = RESET_PATH.read_text(encoding="utf-8")
        for marker in ("auth.json", "access_token", "refresh_token", "Bearer "):
            self.assertNotIn(marker, source)
        self.assertNotIn("url=", source)
        self.assertNotIn("request.url", source)

    def test_entry_projection_is_verbatim_official_fields(self):
        self.assertEqual(
            set(reset_service._RESET_ENTRY_FIELDS),
            {"id", "reset_type", "status", "granted_at", "expires_at", "title", "description"},
        )
        self.assertEqual(reset_service._reset_timestamp("2026-07-17T00:00:00Z"), "2026-07-17T00:00:00Z")
        self.assertIsNone(reset_service._reset_timestamp("not-a-date"))


if __name__ == "__main__":
    unittest.main()
