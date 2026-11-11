"""Provider usage and balance API for the Hermes Desktop provider-usage plugin.

The desktop plugin talks only to this scoped backend namespace. Provider
credentials are resolved by Hermes' existing runtime/auth machinery and never
cross the plugin API boundary or enter the returned JSON.
"""

from __future__ import annotations

import concurrent.futures
import html
import json
import logging
import math
import re
import struct
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

import httpx
from fastapi import APIRouter, Body

router = APIRouter()
log = logging.getLogger(__name__)

_PROVIDER_LABELS = {
    "openai-codex": "OpenAI Codex",
    "anthropic": "Anthropic",
    "openrouter": "OpenRouter",
    "deepseek": "DeepSeek",
    "xai-oauth": "SuperGrok / xAI OAuth",
    "nous": "Nous Portal",
    "openai-api": "OpenAI API",
    "opencode-go": "OpenCode",
    "opencode-zen": "OpenCode",
    "ollama-cloud": "Ollama Cloud",
}
_SUPPORTED = {"openai-codex", "openrouter", "deepseek", "xai-oauth", "nous", "anthropic", "opencode-go", "opencode-zen", "ollama-cloud"}
_ALIASES = {
    "codex": "openai-codex",
    "openai-codex": "openai-codex",
    "xai-oauth": "xai-oauth",
    "supergrok": "xai-oauth",
    "grok-oauth": "xai-oauth",
    "openrouter": "openrouter",
    "deepseek": "deepseek",
    "anthropic": "anthropic",
    "claude": "anthropic",
    "nous": "nous",
    "nous-portal": "nous",
    "opencode-go": "opencode-go",
    "opencode_go": "opencode-go",
    "go": "opencode-go",
    "opencode-go-sub": "opencode-go",
    "opencode-zen": "opencode-zen",
    "opencode_zen": "opencode-zen",
    "opencode": "opencode-zen",
    "zen": "opencode-zen",
    "ollama-cloud": "ollama-cloud",
    "ollama_cloud": "ollama-cloud",
    "auto": "",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    if isinstance(value, str):
        try:
            parsed = float(value.strip())
        except ValueError:
            return None
        return parsed if math.isfinite(parsed) else None
    return None


def _datetime(value: Any) -> Optional[str]:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        parsed = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), timezone.utc).isoformat().replace("+00:00", "Z")
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return None


def _window(label: str, used: Any, reset_at: Any = None, detail: Optional[str] = None) -> dict[str, Any]:
    value = _number(used)
    if value is None:
        return {"label": label, "used_percent": None, "remaining_percent": None, "reset_at": _datetime(reset_at), "detail": detail}
    value = max(0.0, min(100.0, value))
    return {
        "label": label,
        "used_percent": round(value, 2),
        "remaining_percent": round(max(0.0, 100.0 - value), 2),
        "reset_at": _datetime(reset_at),
        "detail": detail,
    }


def _base(provider: str, *, title: str, source: str, plan: Optional[str] = None) -> dict[str, Any]:
    return {
        "id": provider,
        "label": _PROVIDER_LABELS.get(provider, provider),
        "available": False,
        "configured": True,
        "capability": "usage" if provider in {"openai-codex", "anthropic", "xai-oauth", "opencode-go", "ollama-cloud"} else "balance",
        "source": source,
        "fetched_at": _now(),
        "title": title,
        "plan": plan,
        "limits": [],
        "balances": [],
        "credit_status": None,
        "model_access": [],
        "reset_credits": None,
        "spend_control": None,
        "renewal_at": None,
        "pricing": [],
        "demand": [],
        "peak": None,
        "cache": None,
        "activity": None,
        "key_usage": None,
        "products": [],
        "breakdown": [],
        "breakdown_note": None,
        "details": [],
        "unavailable_reason": None,
    }


def _unavailable(provider: str, reason: str, *, configured: bool = True) -> dict[str, Any]:
    row = _base(provider, title="Provider usage", source="none")
    row["configured"] = configured
    row["capability"] = "unsupported" if provider not in _SUPPORTED else row["capability"]
    row["unavailable_reason"] = reason
    return row


def _serialize_snapshot(snapshot: Any) -> dict[str, Any]:
    provider = str(getattr(snapshot, "provider", "") or "")
    row = _base(
        provider,
        title=str(getattr(snapshot, "title", "Account limits") or "Account limits"),
        source=str(getattr(snapshot, "source", "") or ""),
        plan=getattr(snapshot, "plan", None),
    )
    windows = []
    for item in getattr(snapshot, "windows", ()) or ():
        windows.append(
            _window(
                str(getattr(item, "label", "Limit") or "Limit"),
                getattr(item, "used_percent", None),
                getattr(item, "reset_at", None),
                getattr(item, "detail", None),
            )
        )
    if windows:
        row["limits"] = [{"id": "default", "label": row["title"], "windows": windows}]
    row["details"] = [str(value) for value in (getattr(snapshot, "details", ()) or ())]
    reason = getattr(snapshot, "unavailable_reason", None)
    row["unavailable_reason"] = str(reason) if reason else None
    row["available"] = bool((windows or row["details"]) and not row["unavailable_reason"])
    fetched_at = getattr(snapshot, "fetched_at", None)
    if isinstance(fetched_at, datetime):
        row["fetched_at"] = _datetime(fetched_at) or row["fetched_at"]
    return row


def _safe_request_error(exc: BaseException) -> str:
    """Return a useful error without echoing URLs, headers, or credentials."""
    if isinstance(exc, httpx.HTTPStatusError):
        return f"Provider returned HTTP {exc.response.status_code}."
    if isinstance(exc, httpx.TimeoutException):
        return "Provider request timed out."
    if isinstance(exc, httpx.RequestError):
        return "Provider request failed."
    return f"{type(exc).__name__} while reading provider data."


def _runtime(provider: str, *, base_url: Optional[str] = None, api_key: Optional[str] = None) -> dict[str, Any]:
    from hermes_cli.runtime_provider import resolve_runtime_provider

    return resolve_runtime_provider(
        requested=provider,
        explicit_base_url=base_url,
        explicit_api_key=api_key,
    )


def _fetch_codex() -> dict[str, Any]:
    # Fetch + auth live in Hermes core (`agent.account_usage`): shared credential
    # handling, the per-profile cache the desktop pickers read, and the 401
    # refresh path. The decoded response body rides back on ``snapshot.raw``; the
    # groups core does not normalize yet (metered features, code review, spend
    # control) are read from it below instead of re-requesting the endpoint.
    from agent.account_usage import fetch_account_usage

    snapshot = fetch_account_usage("openai-codex")
    if snapshot is None:
        raise RuntimeError("Codex usage is unavailable")
    payload = getattr(snapshot, "raw", None)
    payload = dict(payload) if isinstance(payload, dict) else {}
    if not payload:
        # Core build without a raw body: normalized windows/details only.
        row = _base("openai-codex", title="Codex limits", source=str(getattr(snapshot, "source", "") or "usage_api"),
                    plan=str(getattr(snapshot, "plan", "") or "") or None)
        windows = [
            _window(str(getattr(window, "label", "Limit") or "Limit"), getattr(window, "used_percent", None),
                    getattr(window, "reset_at", None), getattr(window, "detail", None))
            for window in (getattr(snapshot, "windows", ()) or ())
        ]
        if windows:
            row["limits"] = [{"id": "default", "label": "Codex", "windows": windows}]
        row["details"] = [str(value) for value in (getattr(snapshot, "details", ()) or ())]
        row["available"] = bool(row["limits"] or row["details"])
        return row
    raw_plan = str(payload.get("plan_type") or "").strip().lower()
    plan_names = {
        "prolite": "ChatGPT Pro 5x",
        "pro": "ChatGPT Pro 20x",
        "plus": "ChatGPT Plus",
        "go": "ChatGPT Go",
        "free": "ChatGPT Free",
    }
    row = _base(
        "openai-codex",
        title="Codex limits",
        source="usage_api",
        plan=plan_names.get(raw_plan) or _pretty_name(payload.get("plan_type")),
    )

    def parse_rate(rate: Any, *, group: str = "default") -> list[dict[str, Any]]:
        if not isinstance(rate, dict):
            return []
        values: list[dict[str, Any]] = []
        for key, fallback in (("primary_window", "5-hour"), ("secondary_window", "Weekly")):
            window = rate.get(key) or {}
            if not isinstance(window, dict) or window.get("used_percent") is None:
                continue
            seconds = _number(window.get("limit_window_seconds"))
            if seconds is not None:
                if seconds <= 6 * 3600:
                    label = "5-hour"
                elif seconds <= 8 * 24 * 3600:
                    label = "Weekly"
                else:
                    label = f"{round(seconds / 86400)}-day"
            else:
                label = fallback
            if group != "default":
                label = f"{group} · {label}"
            values.append(_window(label, window.get("used_percent"), window.get("reset_at")))
        if not values and rate.get("used_percent") is not None:
            values.append(_window(group, rate.get("used_percent"), rate.get("reset_at")))
        return values

    default_rate = payload.get("rate_limit") or {}
    default_windows = parse_rate(default_rate)
    if default_windows:
        row["limits"].append({
            "id": "default",
            "label": "Codex",
            "windows": default_windows,
            "allowed": default_rate.get("allowed"),
            "limit_reached": default_rate.get("limit_reached"),
        })
        if not any("5-hour" in str(window.get("label")) for window in default_windows):
            row["details"].append("5-hour window: not exposed by Codex for this account")

    additional = payload.get("additional_rate_limits") or []
    if isinstance(additional, dict):
        additional = [dict(value, limit_name=name) if isinstance(value, dict) else {"limit_name": name} for name, value in additional.items()]
    if isinstance(additional, list):
        for entry in additional:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("limit_name") or entry.get("metered_feature") or entry.get("name") or "Additional limit")
            nested = entry.get("rate_limit") or entry.get("limits") or entry
            windows = parse_rate(nested, group=_pretty_name(name) or name)
            if windows:
                group_id = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "additional"
                row["limits"].append({
                    "id": group_id,
                    "label": _pretty_name(name) or name,
                    "windows": windows,
                    "allowed": nested.get("allowed"),
                    "limit_reached": nested.get("limit_reached"),
                })

    code_review_rate = payload.get("code_review_rate_limit")
    code_review_windows = parse_rate(code_review_rate, group="Code review")
    if code_review_windows:
        row["limits"].append({
            "id": "code-review",
            "label": "Code review",
            "windows": code_review_windows,
            "allowed": code_review_rate.get("allowed"),
            "limit_reached": code_review_rate.get("limit_reached"),
        })

    credits = payload.get("credits") or {}
    balance = _number(credits.get("balance"))
    if credits.get("unlimited"):
        row["details"].append("Extra usage credits: unlimited")
    elif balance is not None:
        row["balances"].append({"label": "Extra usage balance", "amount": balance, "currency": "USD"})
    row["credit_status"] = {
        "enabled": bool(credits.get("has_credits") or credits.get("unlimited") or (balance is not None and balance > 0)),
        "unlimited": bool(credits.get("unlimited")),
        "overage_limit_reached": bool(credits.get("overage_limit_reached")),
        "approx_local_messages": credits.get("approx_local_messages") if isinstance(credits.get("approx_local_messages"), list) else None,
        "approx_cloud_messages": credits.get("approx_cloud_messages") if isinstance(credits.get("approx_cloud_messages"), list) else None,
    }
    reset_credits = payload.get("rate_limit_reset_credits") or {}
    banked = _number(reset_credits.get("available_count"))
    applicable_banked = _number(reset_credits.get("applicable_available_count"))
    if banked is not None or applicable_banked is not None:
        row["reset_credits"] = {
            "available": int(banked or 0),
            "applicable": int(applicable_banked or 0),
        }

    model_usage = payload.get("model_usage") or {}
    if isinstance(model_usage, dict):
        for slug, access in model_usage.items():
            if not isinstance(access, dict):
                continue
            row["model_access"].append({
                "model": _pretty_name(slug) or str(slug),
                "available": access.get("available"),
                "available_at": _datetime(access.get("available_at")),
                "credits_would_enable": bool(access.get("credits_would_enable")),
            })

    spend_control = payload.get("spend_control")
    if isinstance(spend_control, dict):
        row["spend_control"] = {
            "reached": bool(spend_control.get("reached")),
            "individual_limit": _number(spend_control.get("individual_limit")),
        }
    reached_type = str(payload.get("rate_limit_reached_type") or "").strip()
    if reached_type:
        row["details"].append(f"Rate limit reached: {_pretty_name(reached_type) or reached_type}")
    row["available"] = bool(row["limits"] or row["balances"] or row["details"])
    return row


def _fetch_openrouter() -> dict[str, Any]:
    runtime = _runtime("openrouter")
    token = str(runtime.get("api_key") or "").strip()
    if not token:
        raise RuntimeError("no OpenRouter credentials")
    base_url = str(runtime.get("base_url") or "").rstrip("/")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    with httpx.Client(timeout=12.0) as client:
        credits_response = client.get(f"{base_url}/credits", headers=headers)
        credits_response.raise_for_status()
        credits = (credits_response.json() or {}).get("data") or {}
        key_data: dict[str, Any] = {}
        try:
            key_response = client.get(f"{base_url}/key", headers=headers)
            key_response.raise_for_status()
            key_data = (key_response.json() or {}).get("data") or {}
        except httpx.HTTPError:
            log.debug("OpenRouter /key endpoint unavailable", exc_info=True)

    total = _number(credits.get("total_credits"))
    used = _number(credits.get("total_usage"))
    row = _base("openrouter", title="OpenRouter credits", source="credits_api")
    if total is not None and used is not None:
        remaining = max(0.0, total - used)
        row["balances"].append({
            "label": "Credits remaining",
            "amount": remaining,
            "currency": "USD",
            "total": total,
            "used": used,
        })
    elif total is not None:
        row["balances"].append({"label": "Credits", "amount": total, "currency": "USD", "total": total})

    limit = _number(key_data.get("limit"))
    remaining_limit = _number(key_data.get("limit_remaining"))
    if limit is not None and limit > 0 and remaining_limit is not None:
        used_percent = ((limit - max(0.0, min(limit, remaining_limit))) / limit) * 100.0
        detail = f"${remaining_limit:.2f} of ${limit:.2f} remaining"
        if key_data.get("limit_reset"):
            detail += f" • resets {key_data['limit_reset']}"
        row["limits"].append({
            "id": "key",
            "label": "API key quota",
            "windows": [_window("API key quota", used_percent, detail=detail)],
        })

    # Free-model daily request allowance (e.g. 1000/day) — a real quota this key
    # can spend down, so it rides the limit meters like any other window.
    free_quota = key_data.get("free_model_daily_requests") if isinstance(key_data.get("free_model_daily_requests"), dict) else {}
    free_limit = _number(free_quota.get("limit"))
    free_remaining = _number(free_quota.get("remaining"))
    if free_limit is not None and free_limit > 0 and free_remaining is not None:
        free_remaining = max(0.0, min(free_limit, free_remaining))
        free_percent = ((free_limit - free_remaining) / free_limit) * 100.0
        row["limits"].append({
            "id": "default",
            "label": "Free models",
            "windows": [_window("Free model requests", free_percent,
                                detail=f"{int(free_remaining):,} of {int(free_limit):,} requests remaining today")],
        })

    # Per-key spend, structured for the usage panel; the raw fields stay out of
    # ``details`` so nothing renders twice.
    usage = _number(key_data.get("usage"))
    key_usage: dict[str, Any] = {}
    if usage is not None:
        key_usage["total"] = round(usage, 2)
    for field, key in (("usage_daily", "daily"), ("usage_weekly", "weekly"), ("usage_monthly", "monthly")):
        amount = _number(key_data.get(field))
        if amount is not None:
            key_usage[key] = round(amount, 2)
    byok = _number(key_data.get("byok_usage"))
    if byok is not None and byok > 0:
        key_usage["byok_total"] = round(byok, 2)
    if key_usage:
        row["key_usage"] = key_usage
    row["available"] = bool(row["balances"] or row["limits"] or row["details"] or row.get("key_usage"))
    return row


def _deepseek_root(base_url: str) -> str:
    value = base_url.rstrip("/")
    if value.endswith("/v1"):
        value = value[:-3]
    return value.rstrip("/")


def _fetch_deepseek() -> dict[str, Any]:
    runtime = _runtime("deepseek")
    token = str(runtime.get("api_key") or "").strip()
    if not token:
        raise RuntimeError("no DeepSeek credentials")
    url = f"{_deepseek_root(str(runtime.get('base_url') or ''))}/user/balance"
    with httpx.Client(timeout=12.0) as client:
        response = client.get(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        response.raise_for_status()
    payload = response.json() or {}
    infos = payload.get("balance_infos") or payload.get("balances") or []
    if isinstance(infos, dict):
        infos = [infos]
    if not infos and payload.get("currency"):
        infos = [payload]
    row = _base("deepseek", title="DeepSeek balance", source="user_balance_api")
    for info in infos:
        if not isinstance(info, dict):
            continue
        currency = str(info.get("currency") or "USD").upper()
        total = _number(info.get("total_balance"))
        if total is None:
            continue
        granted = _number(info.get("granted_balance"))
        topped = _number(info.get("topped_up_balance"))
        balance_entry = {"label": "Total balance", "amount": total, "currency": currency}
        if granted is not None:
            balance_entry["granted"] = granted
        if topped is not None:
            balance_entry["topped_up"] = topped
        row["balances"].append(balance_entry)
    if payload.get("is_available") is False:
        row["details"].append("Account available: no")
    row["available"] = bool(row["balances"])
    if not row["available"]:
        row["unavailable_reason"] = "DeepSeek returned no balance entries."
    return row


def _fetch_opencode_go() -> dict[str, Any]:
    # The usage endpoint + parse live in the bundled OpenCode Go provider profile
    # (its ``fetch_account_usage`` hook); core runs it and remembers the result in
    # the same per-profile cache the model pickers read.
    from agent.account_usage import fetch_account_usage

    snapshot = fetch_account_usage("opencode-go")
    if snapshot is None:
        # Core swallows hook errors and a missing key as None. Read the usage
        # endpoint once so the pane can say why, instead of "no windows".
        runtime = _runtime("opencode-go")
        token = str(runtime.get("api_key") or "").strip()
        if not token:
            return _unavailable("opencode-go", "OpenCode Go credentials are not configured.")
        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.get(
                    "https://opencode.ai/zen/go/v1/usage",
                    headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                )
                response.raise_for_status()
            usage = (response.json() or {}).get("usage") or {}
        except Exception as exc:
            return _unavailable("opencode-go", _safe_request_error(exc))
        from agent.account_usage import AccountUsageSnapshot, AccountUsageWindow

        parsed = []
        for key, label in (("rolling", "Rolling window"), ("weekly", "Weekly"), ("monthly", "Monthly")):
            window = usage.get(key) or {}
            if not isinstance(window, dict) or window.get("percent") is None:
                continue
            parsed.append(AccountUsageWindow(
                label=label,
                used_percent=float(window["percent"]),
                reset_at=window.get("resetsAt"),
            ))
        snapshot = AccountUsageSnapshot(provider="opencode-go", source="go_usage_api", fetched_at=datetime.now(timezone.utc), windows=tuple(parsed))
    windows = []
    for window in (getattr(snapshot, "windows", ()) or ()):
        label = str(getattr(window, "label", "") or "Limit")
        if label.strip().lower().startswith("rolling"):
            label = "5-hour"  # same rolling window, this pane's label
        windows.append(_window(label, getattr(window, "used_percent", None), getattr(window, "reset_at", None),
                               getattr(window, "detail", None)))

    row = _base("opencode-go", title="OpenCode usage", source="go_usage_api", plan="Go subscription")
    if windows:
        remaining = [window.get("remaining_percent") for window in windows]
        exhausted = any(value is not None and value <= 0 for value in remaining)
        row["limits"] = [{
            "id": "go",
            "label": "Go subscription",
            "windows": windows,
            "allowed": not exhausted,
            "limit_reached": exhausted,
        }]
    allowance_note = "Allowance ceilings: $12 per 5 hours, $30 per week, and $60 per month of usage-equivalent value."
    row["details"].append("If enabled in the OpenCode console, Zen credits can fund requests after a Go limit is reached.")
    row["details"].append("Usage percentages are reported by OpenCode and are not recomputed from token spend.")
    row["products"] = [
        {
            "id": "go",
            "label": "Go subscription",
            "kind": "subscription",
            "available": bool(windows),
            "plan": "Go subscription",
            "limits": row["limits"],
            "balances": [],
            "details": [allowance_note],
            "pricing": [],
            "demand": [],
        },
        {
            "id": "zen",
            "label": "Zen API credits",
            "kind": "balance",
            "available": False,
            "limits": [],
            "balances": [],
            "details": [],
            "pricing": [],
            "demand": [],
            "unavailable_reason": "Zen wallet balance is not exposed through OpenCode API keys.",
        },
    ]
    row["available"] = bool(windows)
    if not row["available"]:
        row["unavailable_reason"] = "OpenCode Go returned no usage windows."
    return row


def _fetch_opencode_zen() -> dict[str, Any]:
    """Verify Zen API access without scraping its browser-only wallet."""
    runtime = _runtime("opencode-zen")
    token = str(runtime.get("api_key") or "").strip()
    if not token:
        raise RuntimeError("OpenCode Zen API key is not configured")
    base_url = str(runtime.get("base_url") or "https://opencode.ai/zen/v1").rstrip("/")
    with httpx.Client(timeout=15.0) as client:
        response = client.get(
            f"{base_url}/models",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )
        response.raise_for_status()
    detail = "Zen API access is authenticated. Credit balance and spend are not exposed through OpenCode API keys."
    row = _base("opencode-zen", title="OpenCode account", source="models_api", plan="Zen API credits")
    row["available"] = True
    row["details"].append(detail)
    row["products"] = [{
        "id": "zen",
        "label": "Zen API credits",
        "kind": "balance",
        "available": True,
        "limits": [],
        "balances": [],
        "details": [detail],
        "pricing": [],
        "demand": [],
    }]
    return row


# Minimal protobuf/gRPC-web reader for grok.com’s subscription credit meter.
def _read_varint(data: bytes, pos: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while True:
        if pos >= len(data) or shift > 70:
            raise ValueError("malformed protobuf varint")
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, pos
        shift += 7


def _fields(data: bytes) -> Iterable[tuple[int, int, Any]]:
    pos = 0
    while pos < len(data):
        key, pos = _read_varint(data, pos)
        number, wire = key >> 3, key & 7
        if wire == 0:
            value, pos = _read_varint(data, pos)
            yield number, wire, value
        elif wire == 1:
            value = data[pos:pos + 8]
            if len(value) != 8:
                raise ValueError("malformed protobuf fixed64")
            pos += 8
            yield number, wire, value
        elif wire == 2:
            length, pos = _read_varint(data, pos)
            value = data[pos:pos + length]
            if len(value) != length:
                raise ValueError("malformed protobuf bytes")
            pos += length
            yield number, wire, value
        elif wire == 5:
            value = data[pos:pos + 4]
            if len(value) != 4:
                raise ValueError("malformed protobuf fixed32")
            pos += 4
            yield number, wire, value
        else:
            raise ValueError(f"unsupported protobuf wire type {wire}")


def _first_message(data: bytes, field_no: int) -> Optional[bytes]:
    return next((value for number, wire, value in _fields(data) if number == field_no and wire == 2), None)


def _cent(data: Optional[bytes]) -> int:
    if not data:
        return 0
    for number, wire, value in _fields(data):
        if number == 1 and wire == 0:
            return int(value)
    return 0


def _timestamp(data: Optional[bytes]) -> Optional[str]:
    if not data:
        return None
    seconds = 0
    nanos = 0
    for number, wire, value in _fields(data):
        if number == 1 and wire == 0:
            seconds = int(value)
        elif number == 2 and wire == 0:
            nanos = int(value)
    if not seconds:
        return None
    return _datetime(seconds + nanos / 1_000_000_000)


def _decode_grpc_web(body: bytes, headers: httpx.Headers) -> bytes:
    messages: list[bytes] = []
    trailers: dict[str, str] = {}
    pos = 0
    while pos < len(body):
        if pos + 5 > len(body):
            raise ValueError("truncated gRPC-web frame")
        flags = body[pos]
        length = int.from_bytes(body[pos + 1:pos + 5], "big")
        pos += 5
        payload = body[pos:pos + length]
        if len(payload) != length:
            raise ValueError("truncated gRPC-web payload")
        pos += length
        if flags & 0x80:
            for line in payload.decode("utf-8", "replace").splitlines():
                if ":" in line:
                    key, value = line.split(":", 1)
                    trailers[key.strip().lower()] = value.strip()
        else:
            messages.append(payload)
    status = trailers.get("grpc-status") or headers.get("grpc-status")
    if status and status != "0":
        raise ValueError(f"gRPC status {status}")
    if not messages:
        raise ValueError("gRPC response contained no message")
    return b"".join(messages)


_GROK_PRODUCT_LABELS = {
    "GrokBot": "Grok Bot",
    "GrokChat": "Chat",
    "GrokVoice": "Voice",
    "GrokImagine": "Imagine",
    "GrokBuild": "Build",
    "GrokAppBuilder": "Apps",
    "Api": "API",
    "API": "API",
    "Cursor": "Cursor",
}
_GROK_PROXY = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
_GROK_SETTINGS = "https://cli-chat-proxy.grok.com/v1/settings"


def _grok_product_label(raw: Any) -> str:
    text = str(raw or "").strip()
    if text in _GROK_PRODUCT_LABELS:
        return _GROK_PRODUCT_LABELS[text]
    cleaned = text.removeprefix("PRODUCT_").replace("_", " ").strip()
    if cleaned.lower().startswith("grok "):
        cleaned = cleaned[5:].strip()
    return cleaned.title() if cleaned else "Other"


def _grok_window_label(period_type: Any) -> str:
    text = str(period_type or "").upper()
    if "WEEK" in text:
        return "Weekly"
    if "MONTH" in text:
        return "Monthly"
    return "Subscription credits"


def _cent_amount(value: Any) -> Optional[float]:
    if isinstance(value, dict):
        value = value.get("val")
    amount = _number(value)
    if amount is None:
        return None
    return amount / 100.0


def _reconcile_breakdown(items: list[dict[str, Any]], aggregate: Optional[float]) -> Optional[list[dict[str, Any]]]:
    """Keep a product split only when it is the same pool as the headline percent."""
    if not items or aggregate is None:
        return None
    total = 0.0
    seen: set[str] = set()
    rows: list[dict[str, Any]] = []
    for item in items:
        ident = str(item.get("id") or "").strip()
        label = str(item.get("label") or "").strip()
        percent = _number(item.get("used_percent"))
        if not ident or not label or percent is None or percent < 0 or not math.isfinite(percent):
            return None
        if ident in seen:
            return None
        seen.add(ident)
        total += percent
        rows.append({"id": ident, "label": label, "used_percent": round(percent, 2)})
    if abs(total - float(aggregate)) > 1.0:
        return None
    rows.sort(key=lambda row: (-row["used_percent"], row["label"]))
    return rows


def _grok_plan(client: httpx.Client, headers: dict[str, str]) -> Optional[str]:
    try:
        response = client.get(_GROK_SETTINGS, headers=headers, timeout=2.0)
        response.raise_for_status()
        payload = response.json() or {}
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    plan = str(payload.get("subscription_tier_display") or "").strip()
    return plan or None


def _apply_grok_breakdown(row: dict[str, Any], products: list[dict[str, Any]], aggregate: Optional[float], period_label: str) -> None:
    breakdown = _reconcile_breakdown(products, aggregate)
    if not breakdown:
        return
    row["breakdown"] = breakdown
    pool = "this week's pool" if period_label == "Weekly" else ("this month's pool" if period_label == "Monthly" else "the subscription pool")
    row["breakdown_note"] = f"Shares of {pool}. Products at 0% are omitted by Grok."


def _fetch_xai_proxy(token: str) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "x-xai-token-auth": "xai-grok-cli",
        "User-Agent": "hermes-provider-usage/0.9",
    }
    with httpx.Client(timeout=15.0) as client:
        response = client.get(_GROK_PROXY, headers=headers)
        response.raise_for_status()
        payload = response.json() or {}
        plan = _grok_plan(client, headers)
    if not isinstance(payload, dict):
        raise ValueError("xAI credits response was not an object")
    config = payload.get("config") if isinstance(payload.get("config"), dict) else payload
    if not isinstance(config, dict):
        raise ValueError("xAI credits response did not contain a config")
    percent = _number(config.get("creditUsagePercent"))
    if percent is None:
        percent = _number(config.get("credit_usage_percent"))
    period = config.get("currentPeriod") if isinstance(config.get("currentPeriod"), dict) else {}
    if not period and isinstance(config.get("current_period"), dict):
        period = config["current_period"]
    period_type = period.get("type") or period.get("period_type")
    reset_at = _datetime(period.get("end") or config.get("billingPeriodEnd") or config.get("billing_period_end"))
    label = _grok_window_label(period_type)
    if percent is None:
        raise ValueError("xAI credits response did not include a usage percent")
    row = _base("xai-oauth", title="Grok credits", source="grok_cli_proxy", plan=plan)
    row["limits"] = [{"id": "supergrok", "label": plan or "Grok", "windows": [_window(label, percent, reset_at)]}]
    products = []
    for item in config.get("productUsage") or config.get("product_usage") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("product") or "").strip()
        used = _number(item.get("usagePercent") if "usagePercent" in item else item.get("usage_percent"))
        if not name or used is None:
            continue
        products.append({"id": name, "label": _grok_product_label(name), "used_percent": used})
    _apply_grok_breakdown(row, products, percent, label)
    prepaid = _cent_amount(config.get("prepaidBalance") if "prepaidBalance" in config else config.get("prepaid_balance"))
    if prepaid is not None and prepaid > 0:
        row["balances"].append({"label": "Prepaid credits", "amount": prepaid, "currency": "USD"})
    if str(config.get("topUpMethod") or config.get("top_up_method") or "") == "TOP_UP_METHOD_SAVED_PAYMENT_METHOD":
        row["details"].append("On-demand top-up uses a saved payment method.")
    if config.get("isUnifiedBillingUser") or config.get("is_unified_billing_user"):
        row["details"].append("One shared pool across Grok products.")
    row["available"] = True
    return row


def _fetch_xai() -> dict[str, Any]:
    runtime = _runtime("xai-oauth")
    token = str(runtime.get("api_key") or "").strip()
    if not token:
        raise RuntimeError("no xAI OAuth credentials")
    try:
        return _fetch_xai_proxy(token)
    except Exception:
        log.debug("xAI credits proxy unavailable; falling back to grok.com billing", exc_info=True)
    endpoint = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/grpc-web+proto",
        "Accept": "application/grpc-web+proto",
        "X-Grpc-Web": "1",
        "Origin": "https://grok.com",
        "Referer": "https://grok.com/",
        "User-Agent": "hermes-provider-usage/0.9",
    }
    with httpx.Client(timeout=15.0) as client:
        response = client.post(endpoint, content=b"\x00\x00\x00\x00\x00", headers=headers)
        response.raise_for_status()
        payload = _decode_grpc_web(response.content, response.headers)
        plan = _grok_plan(client, {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "x-xai-token-auth": "xai-grok-cli",
        })
    config = _first_message(payload, 1)
    if config is None:
        raise ValueError("xAI credit response did not contain a config")
    usage_percent = 0.0
    cap_cents = 0
    used_cents = 0
    reset_at = None
    for number, wire, value in _fields(config):
        if number == 1 and wire == 5:
            usage_percent = float(struct.unpack("<f", value)[0])
        elif number == 2 and wire == 2:
            cap_cents = _cent(value)
        elif number == 3 and wire == 2:
            used_cents = _cent(value)
        elif number == 5 and wire == 2:
            reset_at = _timestamp(value)
    row = _base("xai-oauth", title="Grok credits", source="grok_billing_grpc", plan=plan)
    row["limits"] = [{"id": "supergrok", "label": plan or "Grok", "windows": [_window("Subscription credits", usage_percent, reset_at)]}]
    if cap_cents > 0:
        row["balances"].append({
            "label": "Pay-as-you-go remaining",
            "amount": max(0.0, (cap_cents - used_cents) / 100),
            "currency": "USD",
            "total": cap_cents / 100,
            "used": used_cents / 100,
        })
    row["details"].append("Product breakdown is not on this fallback. The credits proxy is the source for the Grok app split.")
    row["available"] = True
    return row


def _fetch_nous() -> dict[str, Any]:
    from agent.account_usage import build_nous_credits_snapshot
    from hermes_cli.nous_account import get_nous_portal_account_info

    account = get_nous_portal_account_info(force_fresh=True)
    snapshot = build_nous_credits_snapshot(account)
    if snapshot is None:
        raise RuntimeError("Nous Portal did not return account credits")
    return _serialize_snapshot(snapshot)


def _pretty_tokens(value: int) -> str:
    if value >= 1_000_000_000:
        return f"{value / 1_000_000_000:.2f}B"
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.0f}K"
    return str(value)


def _ollama_usage_row(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalize an ollama.com/api/usage payload.

    The endpoint is community-known rather than officially documented, and the
    account decides which windows exist: newer plans report only ``monthly``
    credit usage, older keys also expose ``session``/``weekly``. Usage arrives
    as a 0-1 fraction; it is shown as returned and nothing is estimated. Reset
    times are not published, so they stay unavailable instead of guessed.
    """
    limits_block = payload.get("limits") if isinstance(payload.get("limits"), dict) else {}
    windows: list[dict[str, Any]] = []
    reached = False
    for key, label in (("session", "5-hour"), ("weekly", "Weekly"), ("monthly", "Monthly")):
        entry = limits_block.get(key)
        if not isinstance(entry, dict):
            continue
        fraction = _number(entry.get("usage"))
        if fraction is None:
            continue
        used = fraction * 100.0 if 0.0 <= fraction <= 1.0 else fraction
        if used >= 100.0:
            reached = True
        windows.append(_window(label, used))

    row = _base("ollama-cloud", title="Ollama Cloud", source="usage_api")
    if windows:
        row["limits"] = [{
            "id": "default",
            "label": "Ollama Cloud",
            "windows": windows,
            "allowed": not reached,
            "limit_reached": reached,
        }]

    models = None
    for key in ("monthly", "weekly", "session"):
        entry = limits_block.get(key)
        if isinstance(entry, dict) and entry.get("models"):
            models = entry.get("models")
            break
    if isinstance(models, dict):
        entries = [
            dict(value, name=value.get("name") or name) if isinstance(value, dict) else {"name": name, "request_count": value}
            for name, value in models.items()
        ]
    elif isinstance(models, list):
        entries = [item for item in models if isinstance(item, dict)]
    else:
        entries = []
    for item in entries[:6]:
        name = str(item.get("name") or "").strip()
        count = _number(item.get("request_count"))
        if name and count is not None:
            count_int = int(count)
            row["details"].append(f"{name}: {count_int} request{'s' if count_int != 1 else ''}")

    activity = payload.get("activity") if isinstance(payload.get("activity"), dict) else {}
    cost = str(activity.get("cost") or "").strip()
    if cost:
        try:
            cost_text = f"${float(cost):.2f}"
        except ValueError:
            cost_text = cost
        period = activity.get("period") if isinstance(activity.get("period"), dict) else {}
        period_text = str(period.get("type") or "").replace("_", " ").strip()
        row["details"].append(f"Spend in the {period_text or 'recent period'}: {cost_text}")

    # The endpoint also serves an activity report (range/totals/buckets) — the
    # shape newer accounts get instead of ``limits`` windows. Show what it
    # publishes (spend, requests, tokens, cache) rather than claiming nothing.
    totals = payload.get("totals") if isinstance(payload.get("totals"), dict) else {}
    if totals:
        requests = _number(totals.get("request_count"))
        spend = _number(totals.get("usage_usd"))
        input_tokens = _number(totals.get("input_tokens"))
        cached_tokens = _number(totals.get("cached_input_tokens"))
        output_tokens = _number(totals.get("output_tokens"))
        range_label = str(payload.get("range") or "").strip() or "7d"
        hit_rate = None
        if (cached_tokens is not None and input_tokens not in (None, 0)
                and 0 <= cached_tokens <= input_tokens):
            hit_rate = cached_tokens / input_tokens
        buckets = []
        for bucket in payload.get("buckets") or []:
            if not isinstance(bucket, dict):
                continue
            buckets.append({
                "from": str(bucket.get("from") or "") or None,
                "usd": _number(bucket.get("usage_usd")),
                "requests": _number(bucket.get("request_count")),
            })
        row["activity"] = {
            "range": range_label,
            "requests": int(requests) if requests is not None else None,
            "usd": round(spend, 2) if spend is not None else None,
            "input_tokens": int(input_tokens) if input_tokens is not None else None,
            "cached_tokens": int(cached_tokens) if cached_tokens is not None else None,
            "output_tokens": int(output_tokens) if output_tokens is not None else None,
            "hit_rate": round(hit_rate, 4) if hit_rate is not None else None,
            "buckets": buckets[-8:],
        }
    row["details"].append("Reset times are not published on the usage report; they stay unavailable rather than estimated.")
    row["available"] = bool(windows) or bool(row.get("activity"))
    if not row["available"]:
        row["unavailable_reason"] = "Ollama Cloud returned no usage windows for this account."
    return row


def _ollama_credit_window(included: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Monthly included pool from ``GET /api/balance``. Dollars come from the
    account, never from a plan-name guess."""
    allowance = _number(included.get("allowance_usd"))
    remaining = _number(included.get("balance_usd"))
    if allowance is None or allowance <= 0 or remaining is None:
        return None
    remaining = max(0.0, min(allowance, remaining))
    spent = max(0.0, allowance - remaining)
    period = included.get("period") if isinstance(included.get("period"), dict) else {}
    allowance_text = f"${allowance:.0f}" if allowance == int(allowance) else f"${allowance:.2f}"
    window = _window(
        "Monthly included",
        (spent / allowance) * 100.0,
        reset_at=period.get("until"),
        detail=f"${spent:.2f} spent · ${remaining:.2f} left of {allowance_text}",
    )
    window["spent_usd"] = round(spent, 2)
    window["remaining_usd"] = round(remaining, 2)
    window["allowance_usd"] = round(allowance, 2)
    return window


def _apply_ollama_balance(row: dict[str, Any], payload: dict[str, Any]) -> None:
    included = payload.get("included") if isinstance(payload.get("included"), dict) else {}
    windows: list[dict[str, Any]] = []
    credit = _ollama_credit_window(included)
    if credit:
        windows.append(credit)
    else:
        for key, label in (("session", "5-hour"), ("weekly", "Weekly")):
            entry = included.get(key)
            if not isinstance(entry, dict):
                continue
            remaining = _number(entry.get("remaining_percent"))
            if remaining is None:
                continue
            windows.append(_window(label, max(0.0, min(100.0, 100.0 - remaining)), reset_at=entry.get("resets_at")))
    if windows:
        existing = row.get("limits") if isinstance(row.get("limits"), list) else []
        prior = []
        for group in existing:
            if not isinstance(group, dict):
                continue
            kept = [window for window in (group.get("windows") or []) if isinstance(window, dict) and window.get("label") != "Monthly included"]
            if kept:
                prior.extend(kept)
        row["limits"] = [{
            "id": "default",
            "label": "Ollama Cloud",
            "windows": windows + prior,
            "allowed": all((window.get("remaining_percent") or 0) > 0 for window in windows),
            "limit_reached": any((window.get("remaining_percent") or 0) <= 0 for window in windows),
        }]
        row["details"] = [detail for detail in row.get("details") or [] if "Reset times are not published" not in str(detail)]
        row["available"] = True
        row["unavailable_reason"] = None
    purchased = payload.get("purchased") if isinstance(payload.get("purchased"), dict) else {}
    extra = _number(purchased.get("balance_usd"))
    if extra is not None and extra > 0:
        row.setdefault("balances", []).append({"label": "Purchased credits", "amount": round(extra, 2), "currency": "USD"})
        row["available"] = True
        row["unavailable_reason"] = None


def _fetch_ollama_cloud() -> dict[str, Any]:
    runtime = _runtime("ollama-cloud")
    token = str(runtime.get("api_key") or "").strip()
    if not token:
        raise RuntimeError("no Ollama Cloud credentials")
    base_url = str(runtime.get("base_url") or "https://ollama.com/v1").rstrip("/")
    if base_url.endswith("/v1"):
        base_url = base_url[: -len("/v1")]
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    with httpx.Client(timeout=15.0) as client:
        response = client.get(f"{base_url}/api/usage", headers=headers)
        response.raise_for_status()
        balance_payload: dict[str, Any] = {}
        try:
            balance = client.get(f"{base_url}/api/balance", headers=headers)
            if balance.status_code == 200:
                parsed = balance.json() or {}
                if isinstance(parsed, dict):
                    balance_payload = parsed
        except httpx.HTTPError:
            log.debug("Ollama Cloud balance endpoint unavailable", exc_info=True)
    row = _ollama_usage_row(response.json() or {})
    if balance_payload:
        _apply_ollama_balance(row, balance_payload)
    return row


def _fetch_provider(provider: str) -> dict[str, Any]:
    if provider == "openai-codex":
        return _fetch_codex()
    if provider == "openrouter":
        return _fetch_openrouter()
    if provider == "deepseek":
        return _fetch_deepseek()
    if provider == "opencode-go":
        return _fetch_opencode_go()
    if provider == "opencode-zen":
        return _fetch_opencode_zen()
    if provider == "ollama-cloud":
        return _fetch_ollama_cloud()
    if provider == "xai-oauth":
        return _fetch_xai()
    if provider == "nous":
        return _fetch_nous()
    if provider == "anthropic":
        from agent.account_usage import fetch_account_usage

        snapshot = fetch_account_usage("anthropic")
        if snapshot is None:
            raise RuntimeError("Anthropic usage is unavailable for this account")
        return _serialize_snapshot(snapshot)
    return _unavailable(provider, "No usage or balance endpoint is known for this provider.")


def _pretty_name(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text:
        return None
    lower = text.lower().replace("_", "-")
    if "spark" in lower and "gpt" in lower:
        match = re.search(r"gpt[- ]?([0-9.]+).*spark", lower)
        if match:
            return f"GPT-{match.group(1)}-Codex-Spark"
        return "GPT Codex Spark"
    return text.replace("_", " ").replace("-", " ").title()


def _canonical(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in _ALIASES:
        return _ALIASES[text]
    slug = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return f"custom:{slug}" if slug else ""


def _config_provider_values(value: Any, found: list[str]) -> None:
    if isinstance(value, dict):
        provider = value.get("provider")
        if isinstance(provider, str) and provider.strip():
            found.append(provider)
        for child in value.values():
            _config_provider_values(child, found)
    elif isinstance(value, list):
        for child in value:
            _config_provider_values(child, found)


def _has_local_credentials(provider: str) -> bool:
    try:
        if provider in {"openai-codex", "xai-oauth"}:
            from agent.credential_pool import load_pool

            pool = load_pool(provider)
            if pool and pool.has_credentials():
                return True
        from hermes_cli.auth import get_provider_auth_state

        state = get_provider_auth_state(provider) or {}
        for key in ("access_token", "api_key", "refresh_token", "tokens"):
            value = state.get(key)
            if isinstance(value, str) and value.strip():
                return True
            if isinstance(value, dict) and any(str(item or "").strip() for item in value.values()):
                return True
        # Credentials can also arrive from environment/config alone, with no
        # auth entry — e.g. Ollama Cloud's OLLAMA_API_KEY. A resolvable runtime
        # key counts as local credentials for inventory purposes.
        try:
            from hermes_cli.runtime_provider import resolve_runtime_provider

            runtime = resolve_runtime_provider(requested=provider) or {}
            resolved = str(runtime.get("provider") or "").strip()
            if resolved and resolved != "custom" and str(runtime.get("api_key") or "").strip():
                return True
        except Exception:
            pass
    except Exception:
        return False
    return False


def _inventory() -> list[dict[str, Any]]:
    try:
        from hermes_cli.config import load_config

        config = load_config() or {}
    except Exception:
        config = {}
    raw: list[str] = []
    for key in ("model", "fallback_providers", "moa", "delegation", "auxiliary"):
        _config_provider_values(config.get(key), raw)
    # The model section's provider is a direct field; recursive traversal above
    # already captures it. Custom provider names are intentionally displayed
    # without reading their key material.
    custom_names: dict[str, str] = {}
    custom = config.get("custom_providers") or []
    if isinstance(custom, dict):
        custom = list(custom.values())
    if isinstance(custom, list):
        for entry in custom:
            if isinstance(entry, dict) and entry.get("name"):
                name = str(entry["name"]).strip()
                custom_names[_canonical(name)] = name
                raw.append(name)

    ordered: list[str] = []
    for value in raw:
        provider = _canonical(value)
        if provider and provider not in ordered:
            ordered.append(provider)
    for provider in sorted(_SUPPORTED):
        if provider not in ordered and _has_local_credentials(provider):
            ordered.append(provider)

    rows = []
    for provider in ordered:
        label = custom_names.get(provider) or _PROVIDER_LABELS.get(provider) or provider.removeprefix("custom:").replace("-", " ").title()
        rows.append({
            "id": provider,
            "label": label,
            "configured": True,
            "supported": provider in _SUPPORTED,
            "capability": "usage" if provider in {"openai-codex", "anthropic", "xai-oauth", "opencode-go", "ollama-cloud"} else ("balance" if provider in {"openrouter", "deepseek", "nous", "opencode-zen"} else "unsupported"),
        })
    return rows


# ---------------------------------------------------------------------------
# Rates & peak pricing (display layer)
#
# Rate cards are read from Hermes' own ``agent.usage_pricing`` snapshots — the
# same versioned cards the cost tracker bills against — rather than a second
# copy here, so what this pane shows can drift neither from measured costs nor
# from the vendor's published card. Only officially published data is shown;
# anything unknown stays absent, never estimated.
# ---------------------------------------------------------------------------

_PEAK_SCHEDULES = {
    # DeepSeek bills the listed (off-peak) card; peak hours double it. This
    # entry is both the initial copy and the fallback: _refresh_vendor_specs
    # re-parses the published page (every _VENDOR_REFRESH_TTL_SECS, or on
    # demand) and a successful result overrides it until a later check fails.
    "deepseek": {
        "multiplier": 2.0,
        "schedule": "Peak 2× Mon–Fri 01:00–04:00 & 06:00–10:00 UTC",
        "windows_min_utc": ((60, 240), (360, 600)),
        "weekdays": (0, 1, 2, 3, 4),
        "source_url": "https://api-docs.deepseek.com/quick_start/pricing",
        "parse": "deepseek-pricing",
    },
}

_WEEKDAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _weekday_span(days: list[int]) -> str:
    """'Mon–Fri' / 'Sun–Thu' / 'Daily' for a set of weekday indexes (wrap-aware)."""
    unique = sorted(set(days))
    if len(unique) == 7:
        return "Daily"
    if len(unique) == 1:
        return _WEEKDAY_NAMES[unique[0]]
    day_set = set(unique)
    for start in unique:
        run = [start]
        nxt = (start + 1) % 7
        while nxt in day_set and len(run) < len(unique):
            run.append(nxt)
            nxt = (nxt + 1) % 7
        if len(run) == len(unique):
            return f"{_WEEKDAY_NAMES[run[0]]}–{_WEEKDAY_NAMES[run[-1]]}"
    return ", ".join(_WEEKDAY_NAMES[day] for day in unique)


_VENDOR_CACHE_FILE = Path(__file__).with_name("vendor_page_cache.json")
_VENDOR_REFRESH_TTL_SECS = 12 * 3600
_VENDOR_UA = "HermesProviderUsage/0.8 (published-rates check)"
_vendor_refresh_lock = threading.Lock()
_vendor_refresh_attempts: dict[str, float] = {}


def _timestamp_of(value: Any) -> Optional[float]:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def _parse_peak_schedule(text: str) -> Optional[dict[str, Any]]:
    """Parse DeepSeek's published peak-hours sentence from the pricing page.

    The page reads: "Off-peak rates are half of the peak rates. Peak hours are
    01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding
    Chinese public holidays." Anything not fully understood (hours, day
    pattern, or multiplier) returns None so the caller keeps the previous spec
    rather than trusting half a sentence.
    """
    flat = re.sub(r"\s+", " ", text)
    sentence = re.search(r"peak hours are (.{0,220}?UTC)", flat, re.IGNORECASE)
    if not sentence:
        return None
    spans: list[tuple[int, int]] = []
    for hours_a, minutes_a, hours_b, minutes_b in re.findall(
        r"(\d{1,2}):(\d{2})\s*[-\u2013]\s*(\d{1,2}):(\d{2})", sentence.group(1)
    ):
        start = int(hours_a) * 60 + int(minutes_a)
        end = int(hours_b) * 60 + int(minutes_b)
        if 0 <= start < end <= 24 * 60:
            spans.append((start, end))
    if not spans or len(spans) > 6:
        return None
    if sum(end - start for start, end in spans) > 12 * 60:
        return None
    tail = flat[sentence.end():sentence.end() + 200]
    weekdays: tuple[int, ...]
    if re.search(r"\b(daily|every day)\b", tail, re.IGNORECASE):
        weekdays = (0, 1, 2, 3, 4, 5, 6)
    elif re.search(r"Mon(?:day)?\s*(?:through|to|[-\u2013])\s*Fri(?:day)?", tail, re.IGNORECASE):
        weekdays = (0, 1, 2, 3, 4)
    else:
        return None
    multiplier: Optional[float] = None
    for pattern, compute in (
        (r"off-peak rates are half\b", lambda: 2.0),
        (r"off-peak rates are (\d+(?:\.\d+)?)\s*%", lambda pct: 100.0 / float(pct)),
        (r"peak rates are (\d+(?:\.\d+)?)\s*[x\u00d7]", lambda factor: float(factor)),
    ):
        match = re.search(pattern, flat, re.IGNORECASE)
        if match:
            try:
                multiplier = compute(*match.groups())
            except (TypeError, ValueError):
                multiplier = None
            if multiplier is not None:
                break
    if multiplier is None or not 1.0 <= multiplier <= 10.0:
        return None
    times = " & ".join(
        f"{start // 60:02d}:{start % 60:02d}\u2013{end // 60:02d}:{end % 60:02d}" for start, end in spans
    )
    return {
        "multiplier": multiplier,
        "windows_min_utc": tuple(spans),
        "weekdays": weekdays,
        "schedule": f"Peak {multiplier:g}\u00d7 {_weekday_span(list(weekdays))} {times} UTC",
        "fetched_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def _parse_deepseek_rates(text: str) -> Optional[dict[str, Any]]:
    """Parse DeepSeek's pricing table (off-peak and peak rows) from the page.

    Rows are published as "1M INPUT TOKENS (CACHE HIT|MISS)" / "1M OUTPUT
    TOKENS" with an OFF-PEAK and a PEAK line per model column; the columns come
    from the header row ("deepseek-flash (1)", "deepseek-v4-pro"). Anything not
    fully understood returns None so the caller keeps the last known table
    rather than guessing from half a table.
    """
    cells = [
        re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", cell))).strip()
        for cell in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", text, re.IGNORECASE | re.DOTALL)
    ]
    header = next((index for index, cell in enumerate(cells) if cell.upper() == "MODEL"), None)
    if header is None:
        return None
    models: list[str] = []
    for cell in cells[header + 1:header + 7]:
        name = re.sub(r"\s*\(\d+\)\s*$", "", cell).strip()
        if re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,40}", name):
            models.append(name)
        else:
            break
    if not models or len(models) > 6:
        return None

    def _usd(cell: str) -> Optional[float]:
        match = re.fullmatch(r"\$([0-9]+(?:\.[0-9]+)?)", cell.replace(",", ""))
        if not match:
            return None
        value = float(match.group(1))
        return value if 0 <= value <= 10_000 else None

    parsed: dict[str, dict[str, dict[str, float]]] = {model: {} for model in models}
    for index, cell in enumerate(cells):
        upper = cell.upper()
        if upper.startswith("1M INPUT TOKENS") and "CACHE HIT" in upper:
            metric = "cache_read"
        elif upper.startswith("1M INPUT TOKENS") and "CACHE MISS" in upper:
            metric = "input"
        elif upper.startswith("1M OUTPUT TOKENS"):
            metric = "output"
        else:
            continue
        window = cells[index + 1:index + 1 + 2 * (len(models) + 1)]
        for label, part in (("OFF-PEAK", "off_peak"), ("PEAK", "peak")):
            if label not in window:
                return None
            start = window.index(label) + 1
            values = window[start:start + len(models)]
            amounts = [_usd(value) for value in values]
            if len(values) != len(models) or any(amount is None for amount in amounts):
                return None
            for model, amount in zip(models, amounts):
                parsed[model].setdefault(part, {})[metric] = amount
    for table in parsed.values():
        off_peak = table.get("off_peak") or {}
        if "input" not in off_peak or "output" not in off_peak:
            return None
    return {
        "models": parsed,
        "checked_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def _valid_peak_part(spec: Any) -> bool:
    if not isinstance(spec, dict):
        return False
    spans = spec.get("windows_min_utc")
    multiplier = spec.get("multiplier")
    weekdays = spec.get("weekdays")
    return (
        isinstance(multiplier, (int, float)) and 1.0 <= float(multiplier) <= 10.0
        and isinstance(spans, list) and 1 <= len(spans) <= 6
        and all(
            isinstance(pair, list) and len(pair) == 2
            and isinstance(pair[0], int) and isinstance(pair[1], int)
            and 0 <= pair[0] < pair[1] <= 24 * 60
            for pair in spans
        )
        and isinstance(weekdays, list) and weekdays
        and all(isinstance(day, int) and 0 <= day <= 6 for day in weekdays)
        and isinstance(spec.get("schedule"), str) and spec["schedule"]
    )


def _valid_rates_part(rates: Any) -> bool:
    if not isinstance(rates, dict):
        return False
    models = rates.get("models")
    if not isinstance(models, dict) or not models:
        return False
    for model, table in models.items():
        if not isinstance(model, str) or not isinstance(table, dict):
            return False
        for part in (table.get("off_peak"), table.get("peak")):
            if not isinstance(part, dict):
                return False
            if not all(isinstance(part.get(key), (int, float)) for key in ("input", "output")):
                return False
            for key in ("input", "output", "cache_read"):
                value = part.get(key)
                if value is not None and (not isinstance(value, (int, float)) or not 0 <= float(value) <= 10_000):
                    return False
    return True


def _load_vendor_cache() -> dict[str, dict[str, Any]]:
    """The last successfully parsed vendor-page checks, re-validated on every load."""
    try:
        data = json.loads(_VENDOR_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    valid: dict[str, dict[str, Any]] = {}
    for provider, entry in data.items():
        if not isinstance(entry, dict):
            continue
        clean: dict[str, Any] = {"fetched_at": entry.get("fetched_at")}
        if _valid_peak_part(entry.get("peak")):
            clean["peak"] = entry["peak"]
        if _valid_rates_part(entry.get("rates")):
            clean["rates"] = entry["rates"]
        if len(clean) > 1:
            valid[provider] = clean
    return valid


def _vendor_specs() -> dict[str, dict[str, Any]]:
    """Bundled peak schedules merged with the last vendor-page check (check wins).

    Each entry: {"peak": merged peak spec, "rates": parsed table or None,
    "checked_at": when the page was last checked (None if never)}."""
    specs: dict[str, dict[str, Any]] = {
        provider: {"peak": dict(spec), "rates": None, "checked_at": None}
        for provider, spec in _PEAK_SCHEDULES.items()
    }
    for provider, checked in _load_vendor_cache().items():
        if provider not in specs:
            continue
        entry = specs[provider]
        entry["checked_at"] = checked.get("fetched_at")
        peak = checked.get("peak")
        if isinstance(peak, dict):
            merged = dict(entry["peak"])
            merged.update(peak)
            merged["windows_min_utc"] = tuple((int(a), int(b)) for a, b in peak["windows_min_utc"])
            merged["weekdays"] = tuple(int(day) for day in peak["weekdays"])
            entry["peak"] = merged
        rates = checked.get("rates")
        if isinstance(rates, dict):
            entry["rates"] = rates
    return specs


def _refresh_vendor_specs() -> dict[str, Any]:
    """Fetch each provider's source page once and re-parse everything it publishes
    (peak schedule AND rates); every field keeps its previous value unless the
    corresponding parse fully succeeded."""
    refreshed: dict[str, Any] = {}
    for provider, spec in _PEAK_SCHEDULES.items():
        url = spec.get("source_url")
        if spec.get("parse") != "deepseek-pricing" or not url:
            continue
        try:
            response = httpx.get(url, timeout=15.0, follow_redirects=True,
                                 headers={"User-Agent": _VENDOR_UA})
            response.raise_for_status()
            text = response.text
        except Exception:
            log.debug("vendor page fetch failed for %s", provider, exc_info=True)
            continue
        entry: dict[str, Any] = {
            "fetched_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        peak = _parse_peak_schedule(text)
        if peak:
            peak["source_url"] = url
            entry["peak"] = peak
        rates = _parse_deepseek_rates(text)
        if rates:
            rates["source_url"] = url
            rates["checked_at"] = entry["fetched_at"]
            entry["rates"] = rates
        if "peak" in entry or "rates" in entry:
            refreshed[provider] = entry
    if refreshed:
        try:
            cache = _load_vendor_cache()
            for provider, entry in refreshed.items():
                previous = cache.get(provider) or {}
                merged_entry = {**previous, **entry}
                for part in ("peak", "rates"):
                    # A check that only re-parsed one part must not blank the other.
                    if part not in entry and part in previous:
                        merged_entry[part] = previous[part]
                cache[provider] = merged_entry
            tmp = _VENDOR_CACHE_FILE.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(cache, indent=2, sort_keys=True), encoding="utf-8")
            tmp.replace(_VENDOR_CACHE_FILE)
        except Exception:
            log.debug("vendor cache write failed", exc_info=True)
    return refreshed


def _maybe_refresh_vendor_specs() -> None:
    """Top up stale (> TTL) vendor pages in the background; never blocks a request."""
    cache = _load_vendor_cache()
    now_wall = datetime.now(timezone.utc).timestamp()
    stale: list[str] = []
    for provider in _PEAK_SCHEDULES:
        fetched = _timestamp_of((cache.get(provider) or {}).get("fetched_at"))
        if fetched is not None and now_wall - fetched < _VENDOR_REFRESH_TTL_SECS:
            continue
        if time.monotonic() - _vendor_refresh_attempts.get(provider, 0.0) < _VENDOR_REFRESH_TTL_SECS:
            continue
        stale.append(provider)
    if not stale or _vendor_refresh_lock.locked():
        return

    def _worker() -> None:
        with _vendor_refresh_lock:
            for provider in _PEAK_SCHEDULES:
                _vendor_refresh_attempts[provider] = time.monotonic()
            _refresh_vendor_specs()

    threading.Thread(target=_worker, daemon=True, name="provider-usage-source-refresh").start()


def _peak_state(provider: str, at: Optional[datetime] = None) -> Optional[dict[str, Any]]:
    """Current peak/off-peak state plus the next transition, computed in UTC from the
    provider's published peak schedule. None when no schedule is known for it."""
    entry = _vendor_specs().get(provider) or {}
    spec = entry.get("peak")
    if not spec:
        return None
    now = at or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    weekdays = tuple(spec.get("weekdays") or (0, 1, 2, 3, 4))
    windows: list[tuple[datetime, datetime]] = []
    for offset in range(0, 8):
        day = (now + timedelta(days=offset)).astimezone(timezone.utc)
        if day.weekday() not in weekdays:  # published peak days only
            continue
        midnight = day.replace(hour=0, minute=0, second=0, microsecond=0)
        for start_min, end_min in spec["windows_min_utc"]:
            windows.append((midnight + timedelta(minutes=start_min), midnight + timedelta(minutes=end_min)))
    windows.sort()
    mode, next_change = "off-peak", None
    for start, end in windows:
        if start <= now < end:
            mode, next_change = "peak", end
            break
        if start > now:
            next_change = start
            break

    # Local-time views — the machine's own timezone, so the pane and any agent
    # pulling this payload can plan around "my evening" instead of doing UTC
    # arithmetic. The UTC schedule stays as the vendor-published reference.
    local_tz = datetime.now(timezone.utc).astimezone().tzinfo
    try:
        tz_label = (next_change or now).astimezone(local_tz).tzname()
    except Exception:
        tz_label = None
    groups: dict[tuple[str, str], set[int]] = {}
    for start, end in windows[:14]:
        local_start, local_end = start.astimezone(local_tz), end.astimezone(local_tz)
        groups.setdefault((local_start.strftime("%H:%M"), local_end.strftime("%H:%M")), set()).add(local_start.weekday())
    local_parts = [f"{_weekday_span(sorted(days))} {start_text}–{end_text}"
                   for (start_text, end_text), days in sorted(groups.items(), key=lambda item: item[0][0])]
    multiplier = round(float(spec["multiplier"]), 2)
    schedule_local = None
    if local_parts:
        schedule_local = f"Peak {f'{multiplier:g}'}× " + " · ".join(local_parts)
        if tz_label:
            schedule_local += f" ({tz_label})"
    upcoming = []
    for start, end in windows:
        for moment, kind in ((start, "peak"), (end, "off-peak")):
            if moment > now:
                upcoming.append({
                    "kind": kind,
                    "at": _datetime(moment),
                    "at_local": moment.astimezone(local_tz).isoformat(),
                })
    upcoming.sort(key=lambda item: item["at"])
    windows_local = [
        {"days": [_WEEKDAY_NAMES[day] for day in sorted(days)], "start": start_text, "end": end_text}
        for (start_text, end_text), days in groups.items()
    ]
    return {
        "mode": mode,
        "multiplier": multiplier,
        "schedule": str(spec["schedule"]),
        "schedule_local": schedule_local,
        "windows_local": windows_local,
        "tz": tz_label,
        "source_url": str(spec["source_url"]),
        "schedule_fetched_at": spec.get("fetched_at"),
        "next_change_at": _datetime(next_change),
        "next_change_at_local": next_change.astimezone(local_tz).isoformat() if next_change else None,
        "upcoming": upcoming[:4],
        "as_of": _datetime(now),
    }


def _pricing_rows(provider: str, active_model: str = "") -> list[dict[str, Any]]:
    """Published rate rows for *provider*, from Hermes' pricing snapshots (official docs)
    with the live models.dev/OpenRouter catalog as the fallback core already applies."""
    rows: list[dict[str, Any]] = []
    try:
        from agent.usage_pricing import _OFFICIAL_DOCS_PRICING, get_pricing_entry
    except Exception:
        return rows

    def _amount(value: Any) -> Optional[float]:
        try:
            return float(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    active = str(active_model or "").strip()
    flat = active.rsplit("/", 1)[-1] if active else ""
    snapshot_models = [model for (prov, model) in _OFFICIAL_DOCS_PRICING if prov == provider]
    ordered: list[str] = []
    for candidate in (flat, active):
        if candidate and candidate in snapshot_models and candidate not in ordered:
            ordered.append(candidate)
    if not snapshot_models and provider == "openrouter" and active:
        # OpenRouter bills from its live catalog; resolve just the active model here.
        ordered.append(flat or active)
    for model in snapshot_models:
        if model not in ordered:
            ordered.append(model)
    for model in ordered[:5]:
        try:
            entry = get_pricing_entry(model, provider=provider)
        except Exception:
            continue
        if entry is None:
            continue
        payload = {
            "model": model,
            "input": _amount(getattr(entry, "input_cost_per_million", None)),
            "output": _amount(getattr(entry, "output_cost_per_million", None)),
            "cache_read": _amount(getattr(entry, "cache_read_cost_per_million", None)),
            "cache_write": _amount(getattr(entry, "cache_write_cost_per_million", None)),
            "unit": "USD per 1M tokens",
            "source_url": getattr(entry, "source_url", None) or None,
            "pricing_version": getattr(entry, "pricing_version", None) or None,
            "active": bool(active and (model == active or model == flat or active.endswith("/" + model))),
        }
        if payload["input"] is None and payload["output"] is None:
            continue
        rows.append(payload)
    # Collapse aliases that share one rate card (e.g. the retired DeepSeek ids
    # served at the Flash price); the active model is ordered first, so its name
    # is the one a shared card keeps.
    collapsed: list[dict[str, Any]] = []
    seen_cards: set[tuple] = set()
    for payload in rows:
        card = (payload["input"], payload["output"], payload["cache_read"], payload["cache_write"])
        if card in seen_cards:
            continue
        seen_cards.add(card)
        collapsed.append(payload)
    # Overlay the last vendor-page check when one exists, so the displayed rates
    # — and the cache-savings estimate, which reads these same rows — track the
    # vendor's page instead of waiting for a Hermes card update. ``changed``
    # marks a row whose numbers the check moved away from the bundled card.
    checked = (_vendor_specs().get(provider) or {}).get("rates") or {}
    table = checked.get("models") if isinstance(checked.get("models"), dict) else {}
    if table:
        for payload in collapsed:
            model_table = table.get(payload["model"])
            if not isinstance(model_table, dict):
                continue
            off_peak = model_table.get("off_peak")
            if not isinstance(off_peak, dict):
                continue
            before = (payload["input"], payload["output"], payload["cache_read"])
            for key in ("input", "output", "cache_read"):
                value = off_peak.get(key)
                if isinstance(value, (int, float)):
                    payload[key] = float(value)
            payload["checked_at"] = checked.get("checked_at") or None
            payload["changed_from_card"] = (payload["input"], payload["output"], payload["cache_read"]) != before
    return collapsed


# billing_provider value -> provider row id, for the rare case the ledger slug
# differs from the inventory slug.
_CACHE_ALIASES = {"xai": "xai-oauth"}


def _cache_stats(days: int = 7) -> dict[str, dict[str, Any]]:
    """Cache-hit totals per provider from the local session ledger.

    ``session_model_usage`` in state.db (opened read-only) carries the same
    canonical token buckets the cost tracker bills against — input_tokens
    excludes what was served from cache, cache_read/cache_write are separate —
    so a hit rate here matches what the providers charged for. Savings are
    estimated from the provider's published rate card and stay absent when a
    model's rates are unknown: tokens and hit rate are reported regardless.
    """
    try:
        import sqlite3

        from hermes_constants import get_hermes_home

        db_path = get_hermes_home() / "state.db"
        if not db_path.exists():
            return {}
        cutoff = datetime.now(timezone.utc).timestamp() - days * 86400
        connection = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
        try:
            ledger = connection.execute(
                """
                SELECT u.billing_provider, u.model,
                       SUM(u.input_tokens), SUM(u.output_tokens),
                       SUM(u.cache_read_tokens), SUM(u.cache_write_tokens)
                FROM session_model_usage u
                JOIN sessions s ON s.id = u.session_id
                WHERE s.started_at >= ?
                GROUP BY u.billing_provider, u.model
                """,
                (cutoff,),
            ).fetchall()
        finally:
            connection.close()
    except Exception:
        log.debug("provider-usage cache stats unavailable", exc_info=True)
        return {}

    grouped: dict[str, dict[str, list[int]]] = {}
    for provider, model, input_tokens, output_tokens, cache_read, cache_write in ledger:
        raw_slug = str(provider or "").strip()
        slug = _CACHE_ALIASES.get(raw_slug, raw_slug)
        if not slug or not str(model or "").strip():
            continue
        grouped.setdefault(slug, {})[str(model)] = [
            int(input_tokens or 0), int(output_tokens or 0),
            int(cache_read or 0), int(cache_write or 0),
        ]

    stats: dict[str, dict[str, Any]] = {}
    for slug, models in grouped.items():
        rates = {entry["model"]: entry for entry in _pricing_rows(slug)}
        input_tokens = output_tokens = cache_read = cache_write = 0
        saved = 0.0
        unpriced = 0
        for model, (model_input, model_output, model_read, model_write) in models.items():
            input_tokens += model_input
            output_tokens += model_output
            cache_read += model_read
            cache_write += model_write
            entry = rates.get(model)
            input_rate = entry.get("input") if isinstance(entry, dict) else None
            read_rate = entry.get("cache_read") if isinstance(entry, dict) else None
            if input_rate is not None and read_rate is not None:
                per_million = float(input_rate) - float(read_rate)
                if per_million > 0:
                    saved += model_read / 1_000_000 * per_million
            elif model_read > 0:
                unpriced += 1
        prompt = input_tokens + cache_read + cache_write
        if prompt <= 0:
            continue
        stats[slug] = {
            "days": days,
            "prompt_tokens": prompt,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
            "hit_rate": round(cache_read / prompt, 4),
            "saved_usd": round(saved, 2) if saved > 0 else None,
            "saved_partial": bool(cache_read > 0 and unpriced > 0),
        }
    return stats


@router.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "plugin": "provider-usage", "version": "0.9.0"}


def _clean_profile(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text or text.lower() in {"current", "active"}:
        return None
    return text


@router.post("/overview")
def overview(payload: Optional[dict[str, Any]] = Body(default=None)) -> dict[str, Any]:
    body = payload if isinstance(payload, dict) else {}
    profile = _clean_profile(body.get("profile"))
    # The desktop socket is whichever profile is active. Named bots on this
    # machine still have their own credentials — read those, don't make the
    # user switch profiles to see them.
    from hermes_cli.web_server_profiles import _config_profile_scope

    with _config_profile_scope(profile):
        return _overview_scoped(body, profile)


def _overview_scoped(body: dict[str, Any], profile: Optional[str]) -> dict[str, Any]:
    from contextvars import copy_context

    if body.get("refresh_sources"):
        _refresh_vendor_specs()
    else:
        _maybe_refresh_vendor_specs()
    requested_provider = _canonical(body.get("active_provider")) if body.get("active_provider") else ""
    active_model = str(body.get("active_model") or "").strip()
    inventory = _inventory()
    rows: dict[str, dict[str, Any]] = {}

    supported = [item["id"] for item in inventory if item.get("supported")]
    if supported:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(supported))) as executor:
            futures = {
                executor.submit(copy_context().run, _fetch_provider, provider): provider
                for provider in supported
            }
            for future in concurrent.futures.as_completed(futures):
                provider = futures[future]
                try:
                    row = future.result()
                except Exception as exc:
                    row = _unavailable(provider, _safe_request_error(exc))
                    log.debug("provider-usage %s failed", provider, exc_info=True)
                rows[provider] = row

    cache_stats = _cache_stats()
    providers = []
    for item in inventory:
        provider = item["id"]
        row = rows.get(provider) or _unavailable(provider, "No usage or balance endpoint is known for this provider.")
        row["id"] = provider
        row["label"] = item["label"]
        row["configured"] = bool(item.get("configured"))
        row["capability"] = item.get("capability", row.get("capability"))
        if not row.get("pricing"):
            row["pricing"] = _pricing_rows(provider, active_model)
        if row.get("peak") is None:
            row["peak"] = _peak_state(provider)
        if row.get("cache") is None:
            row["cache"] = cache_stats.get(provider)
        providers.append(row)

    default_provider = ""
    try:
        model_config = __import__("hermes_cli.config", fromlist=["load_config"]).load_config() or {}
        default_provider = _canonical((model_config.get("model") or {}).get("provider"))
    except Exception:
        pass
    active_provider = requested_provider or default_provider or (providers[0]["id"] if providers else "")
    return {
        "version": 1,
        "fetched_at": _now(),
        "account_profile": profile or "default",
        "active": {"provider": active_provider, "model": active_model},
        "default_provider": default_provider,
        "providers": providers,
    }
