"""Provider usage and balance API for the Hermes Desktop provider-usage plugin.

The desktop plugin talks only to this scoped backend namespace. Provider
credentials are resolved by Hermes' existing runtime/auth machinery and never
cross the plugin API boundary or enter the returned JSON.
"""

from __future__ import annotations

import concurrent.futures
import logging
import math
import re
import struct
from datetime import datetime, timezone
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
}
_SUPPORTED = {"openai-codex", "openrouter", "deepseek", "xai-oauth", "nous", "anthropic", "opencode-go", "opencode-zen"}
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
        "capability": "usage" if provider in {"openai-codex", "anthropic", "xai-oauth", "opencode-go"} else "balance",
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
        "products": [],
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
    from agent.account_usage import _resolve_codex_usage_credentials

    # Hermes renamed this private helper while keeping the endpoint contract.
    # Prefer the newer name, then use the installed runtime's canonical URL
    # builder rather than duplicating its backend-api/api-codex split.
    try:
        from agent.account_usage import _resolve_codex_usage_url
    except ImportError:
        from agent.account_usage import _codex_backend_urls

        def _resolve_codex_usage_url(base_url: str) -> str:
            return _codex_backend_urls(base_url)[0]

    token, base_url, account_id = _resolve_codex_usage_credentials(None, None)
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": "codex-cli"}
    if account_id:
        headers["ChatGPT-Account-Id"] = account_id
    with httpx.Client(timeout=15.0) as client:
        response = client.get(_resolve_codex_usage_url(base_url), headers=headers)
        response.raise_for_status()
    payload = response.json() or {}
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
        row["limits"] = [{"id": "key", "label": "API key quota", "windows": [_window("API key quota", used_percent, detail=detail)]}]
    usage = _number(key_data.get("usage"))
    if usage is not None:
        row["details"].append(f"API key usage: ${usage:.2f} total")
    for field, label in (("usage_daily", "today"), ("usage_weekly", "this week"), ("usage_monthly", "this month")):
        amount = _number(key_data.get(field))
        if amount is not None:
            row["details"].append(f"${amount:.2f} {label}")
    row["available"] = bool(row["balances"] or row["limits"] or row["details"])
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
        if granted is not None or topped is not None:
            pieces = []
            if granted is not None:
                pieces.append(f"granted {granted:.2f}")
            if topped is not None:
                pieces.append(f"topped up {topped:.2f}")
            row["details"].append(f"{currency}: " + ", ".join(pieces))
    row["details"].append("Account available: yes" if payload.get("is_available") else "Account available: no")
    row["available"] = bool(row["balances"])
    if not row["available"]:
        row["unavailable_reason"] = "DeepSeek returned no balance entries."
    return row


def _fetch_opencode_go() -> dict[str, Any]:
    runtime = _runtime("opencode-go")
    token = str(runtime.get("api_key") or "").strip()
    if not token:
        raise RuntimeError("no OpenCode Go credentials")
    base_url = str(runtime.get("base_url") or "https://opencode.ai/zen/go/v1").rstrip("/")
    with httpx.Client(timeout=15.0) as client:
        response = client.get(
            f"{base_url}/usage",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )
        response.raise_for_status()
    payload = response.json() or {}
    usage = payload.get("usage") or {}
    labels = (("rolling", "5-hour"), ("weekly", "Weekly"), ("monthly", "Monthly"))
    windows = []
    statuses = []
    for key, label in labels:
        entry = usage.get(key) or {}
        if not isinstance(entry, dict) or entry.get("percent") is None:
            continue
        windows.append(_window(label, entry.get("percent"), entry.get("resetsAt") or entry.get("reset_at")))
        status = str(entry.get("status") or "").strip().lower()
        if status:
            statuses.append(status)

    row = _base("opencode-go", title="OpenCode usage", source="go_usage_api", plan="Go subscription")
    if windows:
        row["limits"] = [{
            "id": "go",
            "label": "Go subscription",
            "windows": windows,
            "allowed": all(status in {"ok", "available"} for status in statuses) if statuses else None,
            "limit_reached": any(status in {"blocked", "exhausted", "limit_reached"} for status in statuses),
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


def _fetch_xai() -> dict[str, Any]:
    runtime = _runtime("xai-oauth")
    token = str(runtime.get("api_key") or "").strip()
    if not token:
        raise RuntimeError("no xAI OAuth credentials")
    endpoint = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/grpc-web+proto",
        "Accept": "application/grpc-web+proto",
        "X-Grpc-Web": "1",
        "Origin": "https://grok.com",
        "Referer": "https://grok.com/",
        "User-Agent": "hermes-provider-usage/0.1",
    }
    with httpx.Client(timeout=15.0) as client:
        response = client.post(endpoint, content=b"\x00\x00\x00\x00\x00", headers=headers)
        response.raise_for_status()
        payload = _decode_grpc_web(response.content, response.headers)
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
    # This endpoint exposes quota data, not a trustworthy subscription-tier
    # name. Keep the label conservative instead of inferring a higher tier.
    row = _base("xai-oauth", title="SuperGrok credits", source="grok_billing_grpc", plan="SuperGrok")
    row["limits"] = [{"id": "supergrok", "label": "SuperGrok credits", "windows": [_window("Subscription credits", usage_percent, reset_at)]}]
    remaining = max(0.0, 100.0 - max(0.0, min(100.0, usage_percent)))
    row["details"].append(f"{remaining:.0f}% remaining")
    if reset_at:
        row["details"].append(f"Resets: {reset_at}")
    if cap_cents > 0:
        row["balances"].append({
            "label": "Pay-as-you-go remaining",
            "amount": max(0.0, (cap_cents - used_cents) / 100),
            "currency": "USD",
            "total": cap_cents / 100,
            "used": used_cents / 100,
        })
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
            "capability": "usage" if provider in {"openai-codex", "anthropic", "xai-oauth", "opencode-go"} else ("balance" if provider in {"openrouter", "deepseek", "nous", "opencode-zen"} else "unsupported"),
        })
    return rows


@router.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "plugin": "provider-usage", "version": "0.3.5"}


@router.post("/overview")
def overview(payload: Optional[dict[str, Any]] = Body(default=None)) -> dict[str, Any]:
    body = payload if isinstance(payload, dict) else {}
    requested_provider = _canonical(body.get("active_provider")) if body.get("active_provider") else ""
    active_model = str(body.get("active_model") or "").strip()
    inventory = _inventory()
    rows: dict[str, dict[str, Any]] = {}

    supported = [item["id"] for item in inventory if item.get("supported")]
    if supported:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(supported))) as executor:
            futures = {executor.submit(_fetch_provider, provider): provider for provider in supported}
            for future in concurrent.futures.as_completed(futures):
                provider = futures[future]
                try:
                    row = future.result()
                except Exception as exc:
                    row = _unavailable(provider, _safe_request_error(exc))
                    log.debug("provider-usage %s failed", provider, exc_info=True)
                rows[provider] = row

    providers = []
    for item in inventory:
        provider = item["id"]
        row = rows.get(provider) or _unavailable(provider, "No usage or balance endpoint is known for this provider.")
        row["id"] = provider
        row["label"] = item["label"]
        row["configured"] = bool(item.get("configured"))
        row["capability"] = item.get("capability", row.get("capability"))
        providers.append(row)

    default_provider = ""
    try:
        model_config = config = __import__("hermes_cli.config", fromlist=["load_config"]).load_config() or {}
        default_provider = _canonical((model_config.get("model") or {}).get("provider"))
    except Exception:
        pass
    active_provider = requested_provider or default_provider or (providers[0]["id"] if providers else "")
    return {
        "version": 1,
        "fetched_at": _now(),
        "active": {"provider": active_provider, "model": active_model},
        "default_provider": default_provider,
        "providers": providers,
    }
