"""Human-confirmed redemption of one banked Codex reset on the active account.

Stock Hermes exposes ``fetch_account_usage("openai-codex", read_only=True)``
(a snapshot with a non-secret ``identity`` and decoded ``raw`` body) and
``redeem_codex_reset_credit()`` (no account selector).  This service therefore
never promises a pooled account: it reads the account Hermes currently
resolves, requires the caller to echo that exact identity, and re-reads it
immediately before core redemption.  That recheck is point-in-time, not an
atomic credential binding: core remains account-implicit, so a pool switch
between the recheck and the redeem call cannot be excluded.  Success is
reported only when an independent same-identity readback shows the banked
count decrease; core's own predicted count is never used as that readback.

Preview -> confirm is the only path.  Preview issues a 120-second, single-use,
hashed token.  Confirm consumes it on the first attempt, takes a non-blocking
per-account lock, re-checks identity/count, calls core exactly once, then reads
back when supported.  No force, purchase, credit selector, caller URL, retry,
credential read, or token handling.  Per-credit expiry is optional broker
metadata; the usage count stays authoritative.
"""

import hashlib
import json
import math
import secrets
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

__all__ = ["INTENT", "CREDIT_KIND", "ACTION_LABEL", "ResetConfirmationStore", "ResetService", "HermesCoreSeam"]

INTENT = "redeem_one_banked_codex_reset"
CREDIT_KIND = "banked_reset"
ACTION_LABEL = "Redeem one banked Codex reset (server-selected)"
_PROVIDER = "openai-codex"
_EXHAUSTED_PERCENT = 100.0
_DEFAULT_TTL_SECONDS = 120
_MAX_TTL_SECONDS = 300
_INVENTORY_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
_MANAGE_URL = "https://chatgpt.com/codex/settings/usage"
_MANAGE_LABEL = "Open Codex usage settings"
_RESET_ENTRY_FIELDS = ("id", "reset_type", "status", "granted_at", "expires_at", "title", "description")
_EXPIRATION_NOTE = (
    "The Codex usage response reports banked-reset counts but not per-credit expiry. "
    "No expiration is shown unless the official inventory reports one."
)

_CONFIRMATION_LOCKS: dict[tuple[str, str], threading.Lock] = {}
_CONFIRMATION_LOCKS_GUARD = threading.Lock()
_SUMMARY_BASE: dict[str, Any] = {
    "ok": False, "action_label": ACTION_LABEL, "available_count": None, "applicable_count": None,
    "counts_reported": False, "reset_executable": False, "exhausted": False, "expiration_reported": False,
    "expiration_note": _EXPIRATION_NOTE, "entries": None, "inventory_source": "usage_summary",
    "inventory_detail": None, "manage_url": _MANAGE_URL, "manage_label": _MANAGE_LABEL,
    "credit_kind": CREDIT_KIND, "purchased_credit_used": False, "windows": [],
}


def _text(value: Any) -> Optional[str]:
    return str(value or "").strip() or None


def _profile_label(profile: Optional[str]) -> str:
    return str(profile or "").strip() or "default"


def _count(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    return int(value) if isinstance(value, float) and math.isfinite(value) and value.is_integer() and value >= 0 else None


def _number(value: Any) -> Optional[float]:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) else None


def _timestamp(value: Any) -> Optional[str]:
    if value is not None and hasattr(value, "isoformat"):
        try:
            return str(value.isoformat())
        except Exception:
            return None
    return _text(value)


def _snapshot_identity(snapshot: Any) -> Optional[str]:
    for name in ("identity", "identity_id", "account_id"):
        value = _text(getattr(snapshot, name, None))
        if value:
            return value
    return None


def _reset_counts(snapshot: Any) -> tuple[Optional[int], Optional[int]]:
    raw = getattr(snapshot, "raw", None)
    credits = raw.get("rate_limit_reset_credits") if isinstance(raw, dict) else None
    if not isinstance(credits, dict):
        return None, None
    return _count(credits.get("available_count")), _count(credits.get("applicable_available_count"))


def _window_rows(snapshot: Any) -> list[dict[str, Any]]:
    return [
        {
            "label": _text(getattr(window, "label", None)) or "Limit",
            "used_percent": _number(getattr(window, "used_percent", None)),
            "reset_at": _timestamp(getattr(window, "reset_at", None)),
            "scope": _text(getattr(window, "scope", None)) or "account",
        }
        for window in (getattr(snapshot, "windows", ()) or ())
    ]


def _reset_timestamp(value: Any) -> Optional[str]:
    text = _text(value)
    if not text:
        return None
    try:
        datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    except ValueError:
        return None
    return text


def _reset_entry(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    entry = {
        key: (_reset_timestamp(value.get(key)) if key in {"granted_at", "expires_at"} else _text(value.get(key)))
        for key in _RESET_ENTRY_FIELDS
    }
    return entry if any(item is not None for item in entry.values()) else None


def _reset_entries(payload: Any) -> Optional[list[dict[str, Any]]]:
    raw = payload.get("credits") if isinstance(payload, dict) else None
    if not isinstance(raw, list):
        return None
    entries = [entry for entry in (_reset_entry(item) for item in raw) if entry is not None]
    return entries or None


def _expiry_note(entries: Optional[list[dict[str, Any]]]) -> tuple[bool, str]:
    if entries is None:
        return False, "Per-credit expiry was not reported by this host or broker build."
    if any(entry.get("expires_at") for entry in entries):
        return True, (
            "Per-credit expirations are provider-reported. The server selects which credit is "
            "consumed, so no single expiry is promised for a redemption."
        )
    return False, "The official inventory reports no expiry for any listed reset credit."


def _fingerprint(identity: str, available: int, applicable: Optional[int]) -> str:
    payload = json.dumps(
        {"identity": identity, "available": available, "applicable": applicable},
        sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _confirmation_lock(profile: str, identity: str) -> threading.Lock:
    with _CONFIRMATION_LOCKS_GUARD:
        return _CONFIRMATION_LOCKS.setdefault((profile, identity), threading.Lock())


@dataclass(frozen=True)
class _Confirmation:
    session_id: str
    profile: str
    identity_id: str
    available_count: int
    applicable_count: Optional[int]
    intent: str
    fingerprint: str
    created_at: float
    expires_at: float


class ResetConfirmationStore:
    """In-memory, short-lived, single-use confirmation tokens (digest only)."""

    def __init__(self, *, max_pending: int = 64):
        self._lock = threading.Lock()
        self._items: dict[str, _Confirmation] = {}
        self._max_pending = max(1, int(max_pending))

    def issue(self, confirmation: _Confirmation, token: Optional[str] = None) -> str:
        raw = _text(token) or secrets.token_urlsafe(32)
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        with self._lock:
            for key in [key for key, item in self._items.items() if item.expires_at <= confirmation.created_at]:
                self._items.pop(key, None)
            if len(self._items) >= self._max_pending:
                self._items.pop(min(self._items.items(), key=lambda item: item[1].created_at)[0], None)
            self._items[digest] = confirmation
        return raw

    def consume(self, token: Optional[str], now: float) -> tuple[str, Optional[_Confirmation]]:
        raw = _text(token)
        if not raw:
            return "missing", None
        with self._lock:
            confirmation = self._items.pop(hashlib.sha256(raw.encode("utf-8")).hexdigest(), None)
        if confirmation is None:
            return "missing", None
        return ("expired", None) if confirmation.expires_at <= now else ("ok", confirmation)


class HermesCoreSeam:
    """Stock Hermes core behind lazy imports; no credential value crosses it."""

    provider = _PROVIDER

    def __init__(self, profile: Optional[str] = None):
        self.profile = _text(profile)

    def scope(self, profile: Optional[str]):
        from hermes_cli.web_server_profiles import _config_profile_scope

        return _config_profile_scope(profile)

    def read(self) -> Any:
        from agent.account_usage import fetch_account_usage

        return fetch_account_usage(self.provider, read_only=True)

    def redeem(self) -> Any:
        from agent.account_usage import redeem_codex_reset_credit

        return redeem_codex_reset_credit()

    def supports_redemption(self) -> bool:
        try:
            from agent.account_usage import redeem_codex_reset_credit

            return callable(redeem_codex_reset_credit)
        except Exception:
            return False

    def inventory(self) -> Any:
        """Official per-credit metadata through core's fixed broker route."""
        from hermes_cli.web_server_profiles import _is_other_profile

        if _is_other_profile(self.profile):
            raise PermissionError("reset inventory is limited to the serving profile")
        from hermes_cli.plugin_provider_requests import credentialed_provider_request

        response = credentialed_provider_request(
            self.provider, "GET", _INVENTORY_URL,
            headers={"Accept": "application/json", "User-Agent": "codex-cli"}, timeout=5.0,
        )
        if getattr(response, "status_code", None) != 200:
            raise RuntimeError("reset inventory request was not successful")
        return response.json()


class ResetService:
    """Read, preview and confirm one banked Codex reset for the active account."""

    def __init__(self, *, profile=None, identity_id=None, session_id=None, core=None, store=None,
                 clock=None, ttl_seconds=_DEFAULT_TTL_SECONDS):
        ttl = int(ttl_seconds)
        if not 1 <= ttl <= _MAX_TTL_SECONDS:
            raise ValueError(f"ttl_seconds must be between 1 and {_MAX_TTL_SECONDS}")
        self.profile, self.identity_id, self.session_id = _text(profile), _text(identity_id), _text(session_id)
        self.core = core or HermesCoreSeam(self.profile)
        self.store = store or ResetConfirmationStore()
        self._clock = clock or time.monotonic
        self.ttl_seconds = ttl

    def _now(self) -> float:
        return float(self._clock())

    def _profile_allowed(self) -> bool:
        if not self.profile:
            return True
        try:
            from hermes_cli.web_server_profiles import _is_other_profile

            return not _is_other_profile(self.profile)
        except Exception:
            return False

    def _supports(self) -> bool:
        probe = getattr(self.core, "supports_redemption", None)
        if callable(probe):
            try:
                return bool(probe())
            except Exception:
                return False
        return callable(getattr(self.core, "redeem", None))

    def _empty(self, state: str, message: str, identity: Optional[str] = None) -> dict[str, Any]:
        return {**_SUMMARY_BASE, "state": state, "message": message, "profile": _profile_label(self.profile),
                "identity_id": identity, "account_label": identity}

    def _inventory_for_summary(self) -> tuple[Optional[list[dict[str, Any]]], str, Optional[str]]:
        reader = getattr(self.core, "inventory", None)
        if not callable(reader):
            return None, "usage_summary", "This host does not expose a per-credit inventory reader; counts remain authoritative."
        try:
            entries = _reset_entries(reader())
        except Exception:
            return None, "usage_summary", "Per-credit inventory could not be read; counts remain authoritative."
        if entries is None:
            return None, "usage_summary", "The inventory returned no usable per-credit rows; counts remain authoritative."
        return entries, "reset_credits_api", None

    def _summary_scoped(self) -> dict[str, Any]:
        try:
            snapshot = self.core.read()
        except Exception:
            snapshot = None
        if snapshot is None:
            return self._empty("unavailable", "No active Codex usage snapshot is available. Nothing was read or spent.")
        identity = _snapshot_identity(snapshot)
        available, applicable = _reset_counts(snapshot)
        windows = _window_rows(snapshot)
        exhausted = any(row["used_percent"] is not None and float(row["used_percent"]) >= _EXHAUSTED_PERCENT
                        and row.get("scope") != "model" for row in windows)
        state = "ready"
        if self.identity_id and identity and self.identity_id != identity:
            state = "account_changed"
        elif not identity:
            state = "account_unverified"
        elif available is None:
            state = "count_unknown"
        elif available <= 0:
            state = "no_banked_resets"
        elif applicable is not None and applicable <= 0:
            state = "not_applicable"
        elif not self._supports():
            state = "reset_unsupported"
        messages = {
            "ready": "Ready to preview one banked Codex reset on the active account. Hermes core still refuses if no limit window is fully exhausted.",
            "account_changed": "Hermes is currently signed in to a different Codex account. Reset stays off for the previous account; check the active account again.",
            "account_unverified": "The active Codex snapshot did not expose a non-secret account identity. Reset stays off because the target account cannot be proven.",
            "count_unknown": "The Codex usage response did not report a banked-reset count. Refusing to guess or spend.",
            "no_banked_resets": "This account has no banked Codex reset credits. Nothing can be redeemed.",
            "not_applicable": "This account reports banked resets, but none are applicable now. Nothing will be spent.",
            "reset_unsupported": "This Hermes core build does not expose the released banked-reset operation. Reset is disabled; use Manage account instead.",
        }
        entries, inventory_source, inventory_detail = None, "usage_summary", None
        expiration_reported, expiration_note = False, _EXPIRATION_NOTE
        if state == "ready":
            entries, inventory_source, inventory_detail = self._inventory_for_summary()
            expiration_reported, expiration_note = _expiry_note(entries)
        return {
            **_SUMMARY_BASE,
            "ok": state in {"ready", "no_banked_resets", "not_applicable"},
            "state": state, "message": messages[state], "profile": _profile_label(self.profile),
            "identity_id": identity, "account_label": identity,
            "available_count": available, "applicable_count": applicable,
            "counts_reported": available is not None, "reset_executable": state == "ready",
            "exhausted": exhausted, "expiration_reported": expiration_reported,
            "expiration_note": expiration_note, "entries": entries,
            "inventory_source": inventory_source, "inventory_detail": inventory_detail,
            "windows": windows,
        }

    def summary(self) -> dict[str, Any]:
        """Read-only active-account quota and reset inventory. No mutation."""
        if not self._profile_allowed():
            return self._empty("profile_forbidden", "Reset is limited to the Hermes profile this host serves. Nothing was spent.")
        try:
            with self.core.scope(self.profile):
                return self._summary_scoped()
        except Exception:
            return self._empty("unavailable", "Hermes core reset support is unavailable in this profile. Nothing was spent.")

    def _preview_response(self, *, state, message, summary, confirmation=None) -> dict[str, Any]:
        return {"ok": state == "ready", "state": state, "message": message, "action_label": ACTION_LABEL,
                "summary": summary, "confirmation": confirmation}

    def preview(self) -> dict[str, Any]:
        """Re-read the active account and issue one short-lived confirmation."""
        if not self._profile_allowed():
            return self._preview_response(state="profile_forbidden", summary=None,
                                          message="Reset is limited to the Hermes profile this host serves. Nothing was spent.")
        if not self.session_id:
            return self._preview_response(state="session_unbound", summary=None,
                                          message="A dashboard session is required before a reset can be previewed. Nothing was spent.")
        if not self.identity_id:
            return self._preview_response(state="account_unselected", summary=None,
                                          message="Check the active Codex account first, then confirm that exact account. Nothing was spent.")
        try:
            with self.core.scope(self.profile):
                summary = self._summary_scoped()
        except Exception:
            return self._preview_response(state="core_unavailable", message="Hermes core reset support is unavailable. Nothing was spent.", summary=None)
        if summary["state"] != "ready":
            return self._preview_response(state=summary["state"], message=summary["message"], summary=summary)
        if summary["identity_id"] != self.identity_id:
            return self._preview_response(state="account_changed", summary=summary,
                                          message="The active Codex account changed. Check it again; nothing was spent.")
        identity = str(summary["identity_id"])
        available = int(summary["available_count"])
        now = self._now()
        confirmation = _Confirmation(
            session_id=self.session_id, profile=_profile_label(self.profile), identity_id=identity,
            available_count=available, applicable_count=summary.get("applicable_count"), intent=INTENT,
            fingerprint=_fingerprint(identity, available, summary.get("applicable_count")),
            created_at=now, expires_at=now + self.ttl_seconds,
        )
        return self._preview_response(
            state="ready",
            message=(f"Review the active Codex account {identity!r} and confirm. This spends one banked "
                     "subscription reset, not a purchase or paid API credit; the server selects the credit."),
            summary=summary,
            confirmation={
                "token": self.store.issue(confirmation), "expires_in_seconds": self.ttl_seconds,
                "intent": INTENT, "profile": confirmation.profile, "identity_id": identity,
                "account_label": identity, "available_count": available,
                "applicable_count": confirmation.applicable_count,
                "availability_fingerprint": confirmation.fingerprint,
                "credit_kind": CREDIT_KIND, "purchased_credit_used": False,
            },
        )

    def _confirm_result(self, status, *, message, reason=None, credit_consumed="no", before=None,
                       readback=None, core_result=None, needs_reconcile=False, readback_mismatch=False):
        before = before or {}
        return {
            "ok": status == "reset", "status": status, "reason": reason, "message": message,
            "action_label": ACTION_LABEL, "credit_consumed": credit_consumed, "credit_kind": CREDIT_KIND,
            "purchased_credit_used": False, "profile": _profile_label(self.profile),
            "identity_id": before.get("identity_id") or self.identity_id,
            "account_label": before.get("account_label"), "available_before": before.get("available_count"),
            "available_after": (readback or {}).get("available_count"),
            "windows_reset": _count(getattr(core_result, "windows_reset", None)) or 0,
            "core_status": _text(getattr(core_result, "status", None)) if core_result is not None else None,
            "readback": readback, "needs_reconcile": needs_reconcile, "readback_mismatch": readback_mismatch,
        }

    def _refuse(self, reason: str, message: str, before=None) -> dict[str, Any]:
        return self._confirm_result("refused", reason=reason, message=message, before=before)

    def _recheck(self, confirmation: _Confirmation):
        """Immediate pre-redeem identity/count check against the same read-only resolver."""
        try:
            snapshot = self.core.read()
        except Exception:
            snapshot = None
        if snapshot is None:
            return None, ("account_unavailable", "The active Codex account could not be read before redemption. Nothing was spent.")
        actual = _snapshot_identity(snapshot)
        if actual is None:
            return None, ("account_unverified", "The active Codex account could not be verified before redemption. Nothing was spent.")
        if actual != confirmation.identity_id:
            return None, ("account_changed", "The active Codex account changed after preview. Nothing was spent.")
        available, applicable = _reset_counts(snapshot)
        if available is None:
            return None, ("count_unknown", "The active account did not report a banked-reset count. Nothing was spent.")
        if available <= 0:
            return None, ("no_banked_resets", "This account has no banked Codex reset credits. Nothing was spent.")
        if applicable is not None and applicable <= 0:
            return None, ("not_applicable", "This account reports banked resets, but none are applicable now. Nothing was spent.")
        if _fingerprint(confirmation.identity_id, available, applicable) != confirmation.fingerprint:
            return None, ("availability_changed", "Availability changed after preview. Nothing was spent; preview again.")
        if not self._supports():
            return None, ("reset_unsupported", "This core build does not expose the released banked-reset operation. Nothing was spent.")
        return {"identity_id": actual, "account_label": actual, "available_count": available}, None

    def confirm(self, token: Optional[str], *, confirmed_account: Optional[str],
                confirmed_intent: Optional[str]) -> dict[str, Any]:
        """Consume one preview and redeem one banked reset, at most once."""
        if not self._profile_allowed():
            return self._refuse("profile_forbidden", "Reset is limited to the Hermes profile this host serves. Nothing was spent.")
        identity = self.identity_id
        if not identity:
            return self._refuse("account_unselected", "No exact Codex account is bound to this reset request. Nothing was spent.")
        lock = _confirmation_lock(_profile_label(self.profile), identity)
        if not lock.acquire(blocking=False):
            return self._confirm_result("busy", reason="already_running",
                                        message="A reset for this account is already in progress. Wait for it; do not click again.")
        try:
            token_state, confirmation = self.store.consume(token, self._now())
            if token_state == "expired":
                return self._confirm_result("expired", reason="token_expired",
                                            message="This reset confirmation expired. Check the active account again. Nothing was spent.")
            if token_state != "ok" or confirmation is None:
                return self._confirm_result("invalid_or_used", reason="token_missing_or_used",
                                            message="This reset confirmation is invalid or was already used. Preview again. Nothing was spent.")
            if confirmation.session_id != (self.session_id or ""):
                return self._refuse("session_mismatch", "This confirmation belongs to a different dashboard session. Preview again. Nothing was spent.")
            if confirmation.intent != INTENT or confirmed_intent != INTENT:
                return self._refuse("intent_mismatch", "The confirmation intent did not match a banked Codex reset. Nothing was spent.")
            if confirmation.identity_id != identity or confirmed_account != identity:
                return self._refuse("account_mismatch", "The confirmed account does not exactly match the active account. Nothing was spent.")
            if confirmation.profile != _profile_label(self.profile):
                return self._refuse("profile_changed", "The Hermes profile changed after preview. Nothing was spent; preview again.")

            before = readback = core_result = None
            attempted = False
            try:
                with self.core.scope(self.profile):
                    before, error = self._recheck(confirmation)
                    if error is not None:
                        return self._refuse(*error)
                    attempted = True
                    try:
                        core_result = self.core.redeem()
                    except Exception:
                        core_result = None
                    readback = self._readback_scoped(identity)
            except Exception:
                if not attempted:
                    return self._refuse("core_unavailable", "Hermes core reset support is unavailable. Nothing was spent.")
                readback = readback or self._readback_error()
        finally:
            lock.release()

        status = (_text(getattr(core_result, "status", None)) or "").lower() if core_result is not None else "unavailable"
        before_count = int(before["available_count"]) if before else None
        after_count = (readback or {}).get("available_count")
        readback_mismatch = bool(readback and readback.get("identity_changed"))
        if status == "reset":
            # Core's own "reset" status is not proof.  Confirm only with an
            # independent, same-identity readback that reports a lower count.
            # Never use core_result.available_count: that is the same prediction
            # the confirmation is meant to verify, not a second observation.
            confirmed = (
                bool(readback)
                and readback.get("ok") is True
                and readback.get("error") is None
                and not readback_mismatch
                and str(readback.get("identity_id") or "") == identity
                and isinstance(after_count, int)
                and before_count is not None
                and after_count < before_count
            )
            if confirmed:
                remaining = after_count
                tail = f"{remaining} banked {'reset' if remaining == 1 else 'resets'} {'remains' if remaining == 1 else 'remain'}."
                message = (f"Redeemed one banked Codex reset on {identity}. {tail} The server selected the credit; "
                           "no expiry is promised because the API does not report one.")
                return self._confirm_result("reset", message=message, credit_consumed="yes", before=before,
                                            readback=readback, core_result=core_result)
            message = (
                "Core reported a reset, but an independent readback did not confirm a same-account "
                "banked-reset count decrease. Do not retry: the credit may already be consumed. "
                "Check the account again before starting a new preview."
            )
            if readback_mismatch:
                message += " The readback returned a different account, so its count cannot be attributed."
            elif after_count is None:
                message += " The readback did not report a banked-reset count."
            return self._confirm_result(
                "uncertain", before=before, readback=readback, core_result=core_result,
                credit_consumed="unknown", needs_reconcile=True, readback_mismatch=readback_mismatch,
                message=message,
            )

        refused = {
            "no_credits_banked": "No banked Codex reset credit is available; nothing was spent.",
            "not_exhausted": "Hermes core refused to spend a reset early; nothing was spent.",
            "nothing_to_reset": "The Codex backend reports no exhausted limit to reset; nothing was spent.",
            "no_credit": "The Codex backend reports no available reset credit; nothing was spent.",
            "already_redeemed": "The backend reports this redemption was already processed; nothing new was spent.",
        }
        if status in refused:
            return self._confirm_result("refused", reason=status, message=refused[status], before=before,
                                        readback=readback, core_result=core_result)
        if after_count is not None and before_count is not None and after_count < before_count:
            return self._confirm_result(
                "uncertain", before=before, readback=readback, core_result=core_result, credit_consumed="yes",
                message=(f"The reset request ended uncertainly, but the readback shows banked resets decreased "
                         f"from {before_count} to {after_count}. Treat one reset as consumed; do not retry."),
            )
        return self._confirm_result(
            "uncertain", before=before, readback=readback, core_result=core_result,
            credit_consumed="unknown", needs_reconcile=True,
            message=("The reset request ended with an uncertain result. Do not retry: the credit may already "
                     "have been consumed. Read the account again before starting a new preview."),
        )

    def _readback_error(self) -> dict[str, Any]:
        return {"ok": False, "identity_id": self.identity_id, "identity_changed": False,
                "available_count": None, "applicable_count": None, "exhausted": False, "windows": [],
                "error": "The active account could not be read back.",
                "observed_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}

    def _readback_scoped(self, expected_identity: Optional[str]) -> dict[str, Any]:
        try:
            snapshot = self.core.read()
        except Exception:
            return self._readback_error()
        if snapshot is None:
            return self._readback_error()
        identity = _snapshot_identity(snapshot)
        changed = bool(expected_identity and identity != expected_identity)
        available, applicable = _reset_counts(snapshot)
        windows = _window_rows(snapshot)
        return {
            "ok": not changed, "identity_id": identity, "identity_changed": changed,
            "available_count": available, "applicable_count": applicable,
            "exhausted": any(row["used_percent"] is not None and float(row["used_percent"]) >= _EXHAUSTED_PERCENT
                            and row.get("scope") != "model" for row in windows),
            "windows": windows,
            "error": "The readback returned a different account identity." if changed else None,
            "observed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }

    def readback(self) -> dict[str, Any]:
        """Read current quota after an uncertain result. Never redeems."""
        if not self._profile_allowed():
            return self._readback_error()
        try:
            with self.core.scope(self.profile):
                return self._readback_scoped(self.identity_id)
        except Exception:
            return self._readback_error()
