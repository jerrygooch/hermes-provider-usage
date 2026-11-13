"""Provider usage and balance API for the Hermes Desktop jg-provider-usage plugin.

The desktop plugin talks only to this scoped backend namespace. Provider
credentials are resolved by Hermes core's public read-only usage seams, the
xAI credential broker, or profile-scoped `secret_scope` for declarative
definitions; they never cross the plugin API boundary or enter returned JSON.
"""

import concurrent.futures
import copy
import hashlib
import html
import importlib.util
import inspect
import ipaddress
import json
import logging
import math
import os
import re
import socket
import struct
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Body, Request

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
# Code-owned official account-management landings. These are external links
# only: opening one never changes a plan, payment method, or credential from
# this plugin. Subscription and API products are deliberately separate even
# when one vendor sells both (ChatGPT vs OpenAI API, Claude vs Anthropic
# Console, Grok vs xAI Console, Google AI Studio, Z.ai Coding Plan vs API).
# Keep stable official landing/settings pages here; do not add fragile
# per-invoice or per-key deep links, and do not accept this map from config.
_MANAGE_LINKS: dict[str, tuple[dict[str, str], ...]] = {
    "openai-codex": (
        {"label": "Manage account", "product": "ChatGPT / Codex usage settings", "kind": "subscription",
         "url": "https://chatgpt.com/codex/settings/usage"},
    ),
    "openai-api": (
        {"label": "Manage API", "product": "OpenAI API", "kind": "api",
         "url": "https://platform.openai.com/settings/organization/billing/overview"},
    ),
    "anthropic": (
        {"label": "Manage account", "product": "Claude usage settings", "kind": "subscription",
         "url": "https://claude.ai/settings/usage"},
        {"label": "Manage API", "product": "Anthropic Console", "kind": "api",
         "url": "https://platform.claude.com/settings/billing"},
    ),
    "gemini": (
        {"label": "Manage account", "product": "Google AI Studio", "kind": "api",
         "url": "https://aistudio.google.com/"},
    ),
    "zai": (
        {"label": "Manage account", "product": "Z.ai Coding Plan", "kind": "subscription",
         "url": "https://z.ai/subscribe"},
        {"label": "Manage API", "product": "Z.ai API", "kind": "api",
         "url": "https://z.ai/manage-apikey/apikey-list"},
    ),
    "xai-oauth": (
        {"label": "Manage account", "product": "Grok dashboard", "kind": "subscription",
         "url": "https://grok.com/dashboard"},
        {"label": "Manage API", "product": "xAI Console", "kind": "api",
         "url": "https://console.x.ai/"},
    ),
    "openrouter": (
        {"label": "Manage account", "product": "OpenRouter credits", "kind": "api",
         "url": "https://openrouter.ai/settings/credits"},
    ),
    "deepseek": (
        {"label": "Manage account", "product": "DeepSeek Platform", "kind": "api",
         "url": "https://platform.deepseek.com/"},
    ),
    "nous": (
        {"label": "Manage account", "product": "Nous Portal", "kind": "account",
         "url": "https://portal.nousresearch.com/"},
    ),
    "opencode-go": (
        {"label": "Manage account", "product": "OpenCode Go", "kind": "subscription",
         "url": "https://opencode.ai/go"},
    ),
    "opencode-zen": (
        {"label": "Manage account", "product": "OpenCode Zen", "kind": "api",
         "url": "https://opencode.ai/zen"},
    ),
    "ollama-cloud": (
        {"label": "Manage API", "product": "Ollama API keys", "kind": "api",
         "url": "https://ollama.com/settings/keys"},
    ),
}
_SCOPE_MANAGE_LINKS: dict[tuple[str, str], tuple[dict[str, str], ...]] = {
    ("anthropic", "claude-subscription"): _MANAGE_LINKS["anthropic"][:1],
    ("anthropic", "anthropic-api"): _MANAGE_LINKS["anthropic"][1:],
    ("gemini", "gemini-api-key"): _MANAGE_LINKS["gemini"],
    ("gemini", "usage-billing"): (
        {"label": "Manage account", "product": "Google AI Studio billing", "kind": "api",
         "url": "https://aistudio.google.com/billing"},
    ),
    ("zai", "coding-plan"): _MANAGE_LINKS["zai"][:1],
    ("zai", "standard-api"): _MANAGE_LINKS["zai"][1:],
    ("zai", "endpoints"): (
        {"label": "Docs", "product": "Z.ai endpoints", "kind": "docs",
         "url": "https://docs.z.ai/devpack/quick-start"},
    ),
}
# Always-listed provider connection cards. These are metadata, not adapters:
# nothing here performs a request, reads a credential value, or carries a
# balance/quota figure. ``provider`` is the Hermes provider slug whose
# non-secret presence summary decides Connected vs Not connected. Scopes keep
# subscription quota and API billing separate because they are different
# products even when one vendor sells both.
_CONNECTION_CARDS = (
    {
        "id": "anthropic",
        "name": "Claude / Anthropic",
        "provider": "anthropic",
        "description": (
            "Claude subscription limits through Hermes' read-only Claude Code sign-in. "
            "Anthropic API usage is a separate organization-level product."
        ),
        "docs_url": "https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan",
        "scopes": (
            {
                "id": "claude-subscription",
                "label": "Claude subscription (Pro, Max, Ultra)",
                "mode": "subscription",
                "detail": (
                    "Claude Code reports a 5-hour session limit and a weekly limit on Pro and Max; "
                    "Ultra reports a weekly limit. Hermes core reads these windows from the existing "
                    "Claude Code OAuth grant without refreshing it."
                ),
                "docs_url": "https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan",
            },
            {
                "id": "anthropic-api",
                "label": "Anthropic API usage (Admin API)",
                "mode": "api",
                "static_state": "needs_permission",
                "detail": (
                    "Organization usage and cost reports require an Admin API key (sk-ant-admin…) with "
                    "the admin role; individual accounts cannot use the Admin API. This card does not "
                    "read, meter, or estimate API usage."
                ),
                "docs_url": "https://platform.claude.com/docs/en/manage-claude/usage-cost-api",
            },
        ),
        "setup": {
            "summary": (
                "Sign in with Claude Code in this profile to read subscription limits, or configure "
                "an Anthropic API key for inference. The API key alone does not unlock subscription usage."
            ),
            "env": ("ANTHROPIC_API_KEY",),
            "command": "claude",
            "links": (
                {"label": "Claude Code plans", "url": "https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan"},
                {"label": "Admin API", "url": "https://platform.claude.com/docs/en/manage-claude/admin-api"},
                {"label": "Usage and Cost API", "url": "https://platform.claude.com/docs/en/manage-claude/usage-cost-api"},
            ),
        },
        "verification": "No live account in this build. Subscription reads use the existing core adapter; card states and metadata are fixture-tested.",
    },
    {
        "id": "gemini",
        "name": "Google Gemini API",
        "provider": "gemini",
        "description": (
            "Gemini Developer API keys for inference. API usage, rate limits, and prepay credit are "
            "visible in Google AI Studio; no supported account-level balance endpoint is documented "
            "for API keys, so this card shows setup and capability limits only."
        ),
        "docs_url": "https://ai.google.dev/gemini-api/docs/api-key",
        "scopes": (
            {
                "id": "gemini-api-key",
                "label": "Gemini API key (Google AI Studio)",
                "mode": "api",
                "detail": (
                    "Every key belongs to a Google Cloud project. Rate limits are enforced per project "
                    "(RPM, TPM, RPD), not per key. Google AI Pro/Ultra subscription benefits apply in "
                    "the AI Studio web UI only; direct Gemini API use is billed separately through "
                    "the linked Cloud Billing account."
                ),
                "docs_url": "https://ai.google.dev/gemini-api/docs/google-ai-plans",
            },
            {
                "id": "usage-billing",
                "label": "Usage and prepay balance",
                "mode": "api",
                "static_state": "unavailable",
                "detail": (
                    "Google publishes usage in AI Studio (Dashboard → Usage) and prepay balance in "
                    "Billing. This build has no supported read-only balance/quota endpoint for an API "
                    "key; it never infers remaining quota from rate-limit caps or local token totals."
                ),
                "docs_url": "https://ai.google.dev/gemini-api/docs/billing",
            },
        ),
        "setup": {
            "summary": (
                "Create a Gemini API key in Google AI Studio, then set GEMINI_API_KEY or GOOGLE_API_KEY "
                "(or configure the Gemini provider in Hermes). Monitor usage and billing in AI Studio."
            ),
            "env": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
            "command": "",
            "links": (
                {"label": "Create API key", "url": "https://aistudio.google.com/apikey"},
                {"label": "Usage dashboard", "url": "https://aistudio.google.com/usage"},
                {"label": "Billing", "url": "https://aistudio.google.com/billing"},
                {"label": "Rate limits", "url": "https://ai.google.dev/gemini-api/docs/rate-limits"},
            ),
        },
        "verification": "No live account and no network adapter. Limit and billing statements are from the linked official docs; rendering is fixture-tested.",
    },
    {
        "id": "zai",
        "name": "Z.ai / GLM",
        "provider": "zai",
        "description": (
            "GLM Coding Plan or standard pay-as-you-go API access. Hermes configures Z.AI for "
            "inference; this build has no supported read-only quota or balance snapshot for Z.AI."
        ),
        "docs_url": "https://docs.z.ai/devpack/overview",
        "scopes": (
            {
                "id": "coding-plan",
                "label": "GLM Coding Plan (subscription)",
                "mode": "subscription",
                "detail": (
                    "The plan applies a 5-hour limit and a weekly limit, shared across supported tools. "
                    "Coding Plan keys use plan quota and do not consume standard API balance. Usage is "
                    "shown in Z.ai's subscription and usage pages; this card does not invent a "
                    "remaining percentage or credit count."
                ),
                "docs_url": "https://docs.z.ai/devpack/overview",
            },
            {
                "id": "standard-api",
                "label": "Standard API (pay-as-you-go)",
                "mode": "api",
                "detail": (
                    "Standard API keys bill per token from account balance or applicable usage bundles. "
                    "Standard keys do not consume Coding Plan quota, even inside a coding tool. Plan and "
                    "API credentials are managed separately and are not interchangeable."
                ),
                "docs_url": "https://docs.z.ai/devpack/notice/api-key-management",
            },
            {
                "id": "endpoints",
                "label": "Regional endpoints",
                "mode": "api",
                "static_state": "info",
                "detail": (
                    "Global host: api.z.ai. China host: open.bigmodel.cn. Coding Plan uses "
                    "/api/coding/paas/v4 (OpenAI) or /api/anthropic; the standard API uses "
                    "/api/paas/v4. The key type, not the endpoint, determines billing."
                ),
                "docs_url": "https://docs.z.ai/devpack/quick-start",
            },
        ),
        "setup": {
            "summary": (
                "Create a Coding Plan or Standard API key in Z.ai, then set GLM_API_KEY, ZAI_API_KEY, "
                "or Z_AI_API_KEY and the matching base URL. Hermes can auto-detect the global, China, "
                "and coding endpoints, or GLM_BASE_URL can pin one."
            ),
            "env": ("GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"),
            "command": "",
            "links": (
                {"label": "Coding Plan", "url": "https://z.ai/subscribe"},
                {"label": "API keys", "url": "https://z.ai/manage-apikey/apikey-list"},
                {"label": "Subscription and usage", "url": "https://z.ai/manage-apikey/subscription"},
                {"label": "China endpoint", "url": "https://open.bigmodel.cn/dev/api"},
            ),
        },
        "verification": "No live account and no core account-usage hook. Product separation and endpoints are from official docs and Hermes' provider routing; rendering is fixture-tested.",
    },
)
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


def _safe_https_url(value: Any) -> Optional[str]:
    """Return an HTTPS URL with a host and no embedded credentials, else None."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parts = urlsplit(text)
    except ValueError:
        return None
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        return None
    return text


def _manage_links_for(provider: str, scope_id: Optional[str] = None) -> list[dict[str, str]]:
    """Code-owned official account links for one provider or product scope."""
    source = _SCOPE_MANAGE_LINKS.get((provider, scope_id), ()) if scope_id else _MANAGE_LINKS.get(provider, ())
    links: list[dict[str, str]] = []
    for item in source or ():
        url = _safe_https_url(item.get("url"))
        if not url:
            continue
        links.append({
            "label": str(item.get("label") or "Manage account"),
            "product": str(item.get("product") or ""),
            "kind": str(item.get("kind") or "account"),
            "url": url,
        })
    return links


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
        "manage_links": _manage_links_for(provider),
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


def _snapshot_raw(snapshot: Any) -> dict[str, Any]:
    raw = getattr(snapshot, "raw", None)
    return raw if isinstance(raw, dict) else {}


def _stamp_snapshot(row: dict[str, Any], snapshot: Any) -> dict[str, Any]:
    """Carry the core-owned, non-secret snapshot identity onto the row.

    ``identity_id``/``account_id``/``profile_scope`` are correlation ids the
    delegation roster publishes; none is a token. Stock core names the stable
    account id ``snapshot.identity``; newer hosts expose ``identity_id``. The
    stock field is mapped to ``identity_id`` so a per-account read can be
    checked against the identity it was requested for. A snapshot that could
    not prove its credential leaves them absent so callers render "unknown"
    rather than attach another account's balance.
    """
    fetched_at = getattr(snapshot, "fetched_at", None)
    if isinstance(fetched_at, datetime):
        row["fetched_at"] = _datetime(fetched_at) or row["fetched_at"]
    for source, key in (
        ("identity_id", "identity_id"),
        ("identity", "identity_id"),
        ("account_id", "account_id"),
        ("profile_scope", "profile_scope"),
    ):
        if str(row.get(key) or "").strip():
            continue
        value = str(getattr(snapshot, source, None) or "").strip()
        if value:
            row[key] = value
    return row


def _serialize_snapshot(snapshot: Any) -> dict[str, Any]:
    provider = str(getattr(snapshot, "provider", "") or "")
    # Core-owned snapshots carry the exact decoded provider body on ``raw`` for
    # providers whose normalized details cannot express the pane's fields:
    # OpenRouter's free-model quota/key spend/BYOK, DeepSeek's per-currency
    # granted/topped-up rows, Ollama's activity report and allowance window, and
    # OpenCode Go's whole usage body. The parsers below are the same ones the
    # adapters have always used; only the fetch moved into core.
    raw = _snapshot_raw(snapshot)
    if provider == "openrouter" and isinstance(raw.get("credits"), dict):
        raw_key = raw.get("key")
        key_data = raw_key if isinstance(raw_key, dict) else {}
        return _stamp_snapshot(_openrouter_row(raw["credits"], key_data), snapshot)
    if provider == "deepseek" and isinstance(raw.get("balance"), dict):
        return _stamp_snapshot(_deepseek_row(raw["balance"]), snapshot)
    if provider == "ollama-cloud" and isinstance(raw.get("usage"), dict):
        row = _ollama_usage_row(raw["usage"])
        balance = raw.get("balance")
        if isinstance(balance, dict) and balance:
            _apply_ollama_balance(row, balance)
        return _stamp_snapshot(row, snapshot)
    if provider == "opencode-zen":
        models = raw.get("models")
        return _stamp_snapshot(_zen_row(models), snapshot)
    if provider == "opencode-go":
        return _stamp_snapshot(_go_row(snapshot), snapshot)
    row = _base(
        provider,
        title=str(getattr(snapshot, "title", "Account limits") or "Account limits"),
        source=str(getattr(snapshot, "source", "") or ""),
        plan=getattr(snapshot, "plan", None),
    )
    windows = []
    for item in getattr(snapshot, "windows", ()) or ():
        window = _window(
            str(getattr(item, "label", "Limit") or "Limit"),
            getattr(item, "used_percent", None),
            getattr(item, "reset_at", None),
            getattr(item, "detail", None),
        )
        # A model-scoped window (Anthropic Opus/Sonnet week) must never read as
        # account-wide exhaustion. The value is non-secret and the pane ignores
        # it, but the normalized row keeps it for other consumers.
        scope = str(getattr(item, "scope", "") or "").strip()
        if scope and scope != "account":
            window["scope"] = scope
        windows.append(window)
    if windows:
        row["limits"] = [{"id": "default", "label": row["title"], "windows": windows}]
    if provider == "openai-codex":
        # Per-account snapshots must keep the reset block; the provider-wide
        # Codex row is richer, but both are read-only projections of core's raw body.
        reset_block = _codex_reset_credits_block(raw)
        if reset_block:
            row["reset_credits"] = reset_block
    row["details"] = [str(value) for value in (getattr(snapshot, "details", ()) or ())]
    reason = getattr(snapshot, "unavailable_reason", None)
    row["unavailable_reason"] = str(reason) if reason else None
    row["available"] = bool((windows or row["details"]) and not row["unavailable_reason"])
    return _stamp_snapshot(row, snapshot)


def _safe_request_error(exc: BaseException) -> str:
    """Return a useful error without echoing URLs, headers, or credentials."""
    if isinstance(exc, httpx.HTTPStatusError):
        return f"Provider returned HTTP {exc.response.status_code}."
    if isinstance(exc, httpx.TimeoutException):
        return "Provider request timed out."
    if isinstance(exc, httpx.RequestError):
        return "Provider request failed."
    return f"{type(exc).__name__} while reading provider data."


_CORE_SEAM_UPGRADE = (
    "This Hermes build does not expose the read-only provider-usage snapshot API "
    "(fetch_account_usage(read_only=True)). Upgrade Hermes to a build with that "
    "read-only route. The plugin keeps no token and has no raw-credential fallback."
)

# Profile-scoped env names Hermes itself uses for each API-key provider. Values
# are read only through agent.secret_scope.get_secret (never os.environ) and only
# for presence labels or that provider's fixed official usage endpoint.
_PROVIDER_ENV_SECRETS: dict[str, tuple[str, ...]] = {
    "anthropic": ("ANTHROPIC_API_KEY",),
    "gemini": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    "zai": ("GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"),
    "openrouter": ("OPENROUTER_API_KEY",),
    "deepseek": ("DEEPSEEK_API_KEY",),
    "ollama-cloud": ("OLLAMA_API_KEY",),
    "opencode-zen": ("OPENCODE_ZEN_API_KEY",),
    "opencode-go": ("OPENCODE_GO_API_KEY",),
}
# Stock Hermes has API-key-only products here: presence can be answered from the
# profile env without reading a credential store. OAuth/pool-capable providers
# stay "unknown" when no env key exists.
_API_KEY_ONLY = frozenset({
    "gemini", "zai", "openrouter", "deepseek", "ollama-cloud", "opencode-zen", "opencode-go",
})


def _core_helper(name: str) -> Any:
    """Return a core account-usage helper, or None on a build that lacks it."""
    try:
        from agent import account_usage

        helper = getattr(account_usage, name, None)
    except Exception:
        return None
    return helper if callable(helper) else None


def _core_seam_available() -> bool:
    """True when the read-only usage snapshot route exists (stock 0.23.1 does).

    Enhanced helpers (identity inventory, non-secret credential summary, xAI
    broker) are probed individually where used, never as one global gate.
    """
    return _core_helper("fetch_account_usage") is not None


def _core_usage(provider: str, *, identity_id: Optional[str] = None) -> Any:
    """Read one provider/account snapshot through the public core route.

    ``identity_id`` is the exact non-secret id from
    ``list_account_usage_identities``; core resolves the pooled credential. A
    missing identity or a core without identity-scoped reads returns ``None``
    and is never retried as a provider-wide read.
    """
    fetch = _core_helper("fetch_account_usage")
    if fetch is None:
        return None
    kwargs: dict[str, Any] = {"read_only": True}
    if identity_id is not None:
        try:
            params = inspect.signature(fetch).parameters.values()
        except (TypeError, ValueError):
            return None
        if not any(
            param.name == "identity_id" or param.kind is inspect.Parameter.VAR_KEYWORD
            for param in params
        ):
            return None
        kwargs["identity_id"] = identity_id
    try:
        return fetch(provider, **kwargs)
    except Exception:
        log.debug("provider-usage snapshot failed for %s", provider, exc_info=True)
        return None


def _credential_summary(provider: str) -> dict[str, Any]:
    """Non-secret presence summary when the host offers one; no credential value."""
    summary = _core_helper("provider_credential_summary")
    if summary is None:
        return {}
    try:
        value = summary(provider) or {}
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def _local_presence(provider: str) -> tuple[bool, str, bool]:
    """Return ``(configured, source, known)`` without reading a credential store.

    Core's non-secret summary wins when present. On a stock host the only safe
    presence signal is the profile-scoped env key Hermes itself would use; an
    absent key is conclusive only for API-key-only products. OAuth/pool
    providers stay explicitly unknown rather than being called "not connected".
    """
    summary = _credential_summary(provider)
    if isinstance(summary, dict) and "configured" in summary:
        return bool(summary.get("configured")), str(summary.get("source") or "none"), True
    for name in _PROVIDER_ENV_SECRETS.get(provider, ()):
        if _read_definition_secret(name):
            return True, "env", True
    return False, "none", provider in _API_KEY_ONLY


def _provider_unavailable(provider: str) -> dict[str, Any]:
    """An honest unavailable row: missing route, missing key, or a failed read."""
    if not _core_seam_available():
        return _unavailable(provider, _CORE_SEAM_UPGRADE)
    configured, _source, known = _local_presence(provider)
    label = _PROVIDER_LABELS.get(provider, provider)
    if known and not configured:
        return _unavailable(provider, f"{label} credentials are not configured in this profile.")
    return _unavailable(provider, f"{label} usage is unavailable for this account.")


def _connection_cards() -> list[dict[str, Any]]:
    """Always-listed connection cards for popular providers.

    Presence comes from core's non-secret credential summary when the host
    offers it, otherwise from the profile-scoped env key Hermes itself uses.
    This function performs no request and returns no balance, quota, usage
    window, or credential value: an unconnected or unverifiable card says so
    instead of showing zeros.
    """
    core_ok = _core_seam_available()
    cards: list[dict[str, Any]] = []
    for spec in _CONNECTION_CARDS:
        provider = str(spec["provider"])
        configured, source, known = _local_presence(provider) if core_ok else (False, "none", False)
        if not core_ok:
            state = "unavailable"
            state_detail = (
                "This Hermes build does not expose the read-only usage snapshot API. "
                "Upgrade Hermes to distinguish connected from unconnected accounts."
            )
        elif not known:
            state = "unavailable"
            state_detail = (
                f"This build cannot verify the {spec['name']} sign-in without a non-secret "
                "credential summary. Open the provider's own account page to confirm it; this "
                "card performs no request."
            )
        elif not configured:
            state = "not_connected"
            state_detail = f"No {spec['name']} credentials were found in this profile."
        elif provider == "anthropic" and _anthropic_subscription_connected(source):
            state = "connected"
            state_detail = (
                "Claude Code OAuth credential is connected. Subscription usage is read by Hermes core."
            )
        elif provider == "anthropic":
            state = "connected_no_usage"
            state_detail = (
                "An Anthropic API key is configured for inference. Claude subscription limits require "
                "a Claude Code OAuth sign-in; API usage needs separate organization Admin API access. "
                "An API key neither proves nor disproves an OAuth sign-in, so subscription status is unverified."
            )
        elif provider == "gemini":
            state = "connected_no_usage"
            state_detail = (
                "A Gemini API key is configured for inference. Usage, rate limits, and prepay balance "
                "are shown in Google AI Studio; this plugin has no supported account balance endpoint."
            )
        else:
            state = "connected_no_usage"
            state_detail = (
                "A Z.AI credential is configured for inference. Coding Plan quota and standard API "
                "balance are not exposed to this plugin, and the key type is not verified."
            )

        scopes: list[dict[str, Any]] = []
        for scope in spec["scopes"]:
            item = copy.deepcopy(scope)
            item["manage_links"] = _manage_links_for(provider, str(item.get("id") or ""))
            static_state = item.pop("static_state", None)
            if static_state:
                item["state"] = static_state
            elif not core_ok or not known:
                item["state"] = "unavailable"
            elif not configured:
                item["state"] = "not_connected"
            elif provider == "anthropic" and item["id"] == "claude-subscription":
                subscription = _anthropic_subscription_state(source)
                if subscription == "connected":
                    item["state"] = "connected"
                else:
                    item["state"] = "unverified"
                    item["state_detail"] = (
                        "No authenticated Claude Code OAuth context is available to this build, and an "
                        "API key neither proves nor disproves one. Sign in with Claude Code in this "
                        "profile to read subscription limits."
                    )
            elif provider == "zai":
                item["state"] = "unverified"
                item["state_detail"] = (
                    "The configured key's product type (Coding Plan vs Standard API) is not reported."
                )
            else:
                item["state"] = "connected"
            scopes.append(item)

        cards.append({
            "id": spec["id"],
            "name": spec["name"],
            "provider": provider,
            "description": spec["description"],
            "state": state,
            "state_detail": state_detail,
            "configured": configured,
            "credential_source": source,
            "scopes": scopes,
            "setup": copy.deepcopy(spec["setup"]),
            "docs_url": spec["docs_url"],
            "links": copy.deepcopy(spec["setup"]["links"]),
            "manage_links": _manage_links_for(provider),
            "verification": spec["verification"],
        })
    return cards


def _anthropic_subscription_state(source: str) -> str:
    """Whether a Claude Code OAuth grant is proven, absent, or unverifiable.

    An Anthropic API key is a separate inference credential: its presence says
    nothing about a Claude Code OAuth sign-in, so an env/config key is
    ``unknown`` rather than ``not_connected``.  Pool rows may expose a
    non-secret ``auth_type``; only that metadata is inspected, never a token.
    """
    if source == "oauth":
        return "connected"
    if source == "pool":
        return (
            "connected"
            if any(
                "oauth" in str(account.get("auth_type") or "").lower()
                for account in _account_identities("anthropic")
            )
            else "unknown"
        )
    return "unknown"


def _anthropic_subscription_connected(source: str) -> bool:
    """True only when an OAuth-shaped Claude credential is proven present."""
    return _anthropic_subscription_state(source) == "connected"


_RESET_ENTRY_FIELDS = ("id", "reset_type", "status", "granted_at", "expires_at", "title", "description")


def _codex_reset_entry(value: Any) -> Optional[dict[str, Any]]:
    """Project only the seven official reset-credit fields; never synthesize."""
    if not isinstance(value, dict):
        return None
    entry: dict[str, Any] = {}
    for key in _RESET_ENTRY_FIELDS:
        raw = value.get(key)
        if key in {"granted_at", "expires_at"}:
            text = str(raw or "").strip()
            if text:
                try:
                    datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
                except ValueError:
                    text = ""
            entry[key] = text or None
        else:
            entry[key] = str(raw).strip() if raw is not None and str(raw).strip() else None
    return entry if any(item is not None for item in entry.values()) else None


def _codex_reset_credits_block(payload: Any) -> Optional[dict[str, Any]]:
    """Read-only projection of core's Codex reset blocks.

    Counts stay authoritative from ``rate_limit_reset_credits``.  The optional
    per-credit rows come from ``rate_limit_reset_credits_details`` when a core
    build supplies them; this parser also tolerates ``credits`` nested in the
    summary block.  Expiry is copied only when the provider reports it.
    """
    if not isinstance(payload, dict):
        return None
    summary = payload.get("rate_limit_reset_credits")
    if not isinstance(summary, dict):
        summary = {}
    available = _number(summary.get("available_count"))
    applicable = _number(summary.get("applicable_available_count"))
    details = payload.get("rate_limit_reset_credits_details")
    if not isinstance(details, dict):
        details = {}
    raw_entries = details.get("credits")
    if not isinstance(raw_entries, list):
        raw_entries = summary.get("credits") if isinstance(summary.get("credits"), list) else None
    entries = None
    if raw_entries is not None:
        rows = [entry for entry in (_codex_reset_entry(item) for item in raw_entries) if entry is not None]
        entries = rows or None
    if available is None and applicable is None and entries is None:
        return None
    manage = _MANAGE_LINKS["openai-codex"][0]
    if entries is None:
        inventory_source = "usage_summary"
        detail = "Per-credit expiry is not available from this core build; the provider count is authoritative."
    else:
        inventory_source = "reset_credits_api"
        if any(entry.get("expires_at") for entry in entries):
            detail = "Per-credit expiry is reported by the reset-credit inventory; the server selects the credit."
        else:
            detail = "No expiry is reported for any listed reset credit."
    return {
        "available": int(available) if available is not None else None,
        "applicable": int(applicable) if applicable is not None else None,
        "entries": entries,
        "inventory_source": inventory_source,
        "detail": detail,
        "manage_url": manage["url"],
        "manage_label": "Open Codex usage settings",
    }


def _fetch_codex() -> dict[str, Any]:
    # Fetch + auth live in Hermes core (`agent.account_usage`): shared credential
    # handling, the per-profile cache the desktop pickers read, and the 401
    # refresh path. The decoded response body rides back on ``snapshot.raw``; the
    # groups core does not normalize yet (metered features, code review, spend
    # control) are read from it below instead of re-requesting the endpoint.
    snapshot = _core_usage("openai-codex")
    if snapshot is None:
        return _provider_unavailable("openai-codex")
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
    reset_block = _codex_reset_credits_block(payload)
    if reset_block:
        row["reset_credits"] = reset_block

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
    # Core's read-only snapshot carries the decoded /credits and /key bodies on
    # enhanced builds. Stock 0.23.1 returns the same snapshot without ``raw``;
    # then the profile's own OPENROUTER_API_KEY may read the two documented
    # official endpoints so the pane keeps its free-model quota and key spend.
    snapshot = _core_usage("openrouter")
    if snapshot is not None and isinstance(_snapshot_raw(snapshot).get("credits"), dict):
        return _serialize_snapshot(snapshot)
    direct = _direct_openrouter()
    if direct is not None:
        return direct
    if snapshot is not None:
        return _serialize_snapshot(snapshot)
    return _provider_unavailable("openrouter")


def _fixed_provider_get(url: str, token: str, *, host: str, timeout: float = 12.0) -> httpx.Response:
    """GET one fixed official HTTPS origin with one profile-scoped key.

    No caller-supplied base URL and no redirect following. The token is attached
    here only; a redirect is refused rather than sent to a second origin.
    """
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != host:
        raise RuntimeError("provider endpoint is not the fixed official HTTPS origin")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        response = client.get(url, headers=headers)
    if response.is_redirect:
        raise RuntimeError("provider endpoint redirected; the request was refused")
    response.raise_for_status()
    return response


def _mark_env_read(row: dict[str, Any], name: str) -> dict[str, Any]:
    """Disclose that a row came from this profile's env key, not a pool account."""
    note = f"Read with {name} from this Hermes profile; no pooled account is attributed."
    if note not in row["details"]:
        row["details"].append(note)
    return row


def _direct_openrouter() -> Optional[dict[str, Any]]:
    token = _read_definition_secret("OPENROUTER_API_KEY")
    if not token:
        return None
    try:
        base = "https://openrouter.ai/api/v1"
        credits_response = _fixed_provider_get(f"{base}/credits", token, host="openrouter.ai")
        credits = (credits_response.json() or {}).get("data") or {}
        key_data: dict[str, Any] = {}
        try:
            key_response = _fixed_provider_get(f"{base}/key", token, host="openrouter.ai")
            key_data = (key_response.json() or {}).get("data") or {}
        except Exception:
            log.debug("OpenRouter /key endpoint unavailable", exc_info=True)
        if not isinstance(credits, dict):
            return None
        row = _openrouter_row(credits, key_data if isinstance(key_data, dict) else {})
        return _mark_env_read(row, "OPENROUTER_API_KEY")
    except Exception:
        log.debug("OpenRouter direct env read failed", exc_info=True)
        return None


def _openrouter_row(credits: dict[str, Any], key_data: dict[str, Any]) -> dict[str, Any]:
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


def _deepseek_row(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalize DeepSeek's ``/user/balance`` body (core-owned raw)."""
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


def _fetch_deepseek() -> dict[str, Any]:
    # Enhanced core returns the decoded /user/balance body on ``raw``; stock
    # 0.23.1 has no DeepSeek fetcher. The profile's own DEEPSEEK_API_KEY is the
    # sanctioned stock route to the fixed official balance endpoint.
    snapshot = _core_usage("deepseek")
    if snapshot is not None and isinstance(_snapshot_raw(snapshot).get("balance"), dict):
        return _serialize_snapshot(snapshot)
    direct = _direct_deepseek()
    if direct is not None:
        return direct
    if snapshot is not None:
        return _serialize_snapshot(snapshot)
    return _provider_unavailable("deepseek")


def _direct_deepseek() -> Optional[dict[str, Any]]:
    token = _read_definition_secret("DEEPSEEK_API_KEY")
    if not token:
        return None
    try:
        response = _fixed_provider_get(
            "https://api.deepseek.com/user/balance", token, host="api.deepseek.com", timeout=12.0,
        )
        payload = response.json() or {}
        if not isinstance(payload, dict):
            return None
        return _mark_env_read(_deepseek_row(payload), "DEEPSEEK_API_KEY")
    except Exception:
        log.debug("DeepSeek direct env read failed", exc_info=True)
        return None


def _go_usage_windows(snapshot: Any) -> list[dict[str, Any]]:
    """OpenCode Go windows from the core-owned whole ``{"usage": …}`` body."""
    raw = _snapshot_raw(snapshot)
    usage = raw.get("usage") if isinstance(raw.get("usage"), dict) else None
    windows: list[dict[str, Any]] = []
    if isinstance(usage, dict):
        for key, label in (("rolling", "5-hour"), ("weekly", "Weekly"), ("monthly", "Monthly")):
            window = usage.get(key)
            if not isinstance(window, dict) or _number(window.get("percent")) is None:
                continue
            windows.append(_window(label, window.get("percent"), window.get("resetsAt")))
        if windows:
            return windows
    # A plugin profile hook may normalize windows without a raw body; those are
    # already the same labels the bundled Go endpoint reports.
    for window in (getattr(snapshot, "windows", ()) or ()):
        label = str(getattr(window, "label", "") or "Limit")
        if label.strip().lower().startswith("rolling"):
            label = "5-hour"  # same rolling window, this pane's label
        windows.append(_window(label, getattr(window, "used_percent", None),
                               getattr(window, "reset_at", None), getattr(window, "detail", None)))
    return windows


def _go_row(snapshot: Any) -> dict[str, Any]:
    windows = _go_usage_windows(snapshot)
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


def _fetch_opencode_go() -> dict[str, Any]:
    # Core prefers the bundled provider profile hook and falls back to its own
    # read-only Go fetcher (whole body on ``raw``). Either way the credential is
    # resolved inside core; the plugin has no direct /usage fallback.
    snapshot = _core_usage("opencode-go")
    if snapshot is None:
        return _provider_unavailable("opencode-go")
    return _serialize_snapshot(snapshot)


def _zen_row(models: Any = None) -> dict[str, Any]:
    """Verify Zen API access without scraping its browser-only wallet.

    ``models`` is the core-owned decoded ``/models`` body; its only role is to
    prove the authenticated read succeeded. There is no wallet or spend field to
    preserve, exactly as before the migration.
    """
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


def _fetch_opencode_zen() -> dict[str, Any]:
    # Enhanced core normalizes the authenticated /models read; stock has no Zen
    # fetcher, so the profile's own OPENCODE_ZEN_API_KEY may verify access at the
    # fixed official origin. No wallet figure is invented either way.
    snapshot = _core_usage("opencode-zen")
    if snapshot is not None:
        return _serialize_snapshot(snapshot)
    direct = _direct_opencode_zen()
    if direct is not None:
        return direct
    return _provider_unavailable("opencode-zen")


def _direct_opencode_zen() -> Optional[dict[str, Any]]:
    token = _read_definition_secret("OPENCODE_ZEN_API_KEY")
    if not token:
        return None
    try:
        response = _fixed_provider_get(
            "https://opencode.ai/zen/v1/models", token, host="opencode.ai", timeout=15.0,
        )
        payload = response.json() or {}
        row = _zen_row(payload.get("data") if isinstance(payload, dict) else None)
        return _mark_env_read(row, "OPENCODE_ZEN_API_KEY")
    except Exception:
        log.debug("OpenCode Zen direct env read failed", exc_info=True)
        return None


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
_GROK_BILLING_GRPC = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig"
_GROK_UPGRADE_REASON = (
    "Grok subscription credits need a Hermes build that brokers xAI sign-in through "
    "credentialed_provider_request. This build does not broker xAI. Compatibility mode is off: "
    "set provider_usage.compat_oauth_reads (or HERMES_PROVIDER_USAGE_COMPAT_OAUTH=1) to read "
    "through Hermes's own locked sign-in path instead. The plugin never reads the raw OAuth token. "
    "Manage the Grok plan at https://grok.com/dashboard."
)


class _XaiBrokerUnavailable(RuntimeError):
    """The running core predates the xai-oauth broker route; do not read a raw token instead."""


class _XaiAuthFailure(RuntimeError):
    """The sign-in, permission or endpoint policy failed; never fall back to another route."""


class _XaiHTTPFailure(RuntimeError):
    """A non-auth provider HTTP failure; the credits proxy may still have the gRPC fallback."""


# Compatibility mode: for Hermes builds with no xAI broker route, call core's own resolver
# (the locked refresh path, never auth.json parsed here) and make the request from this
# process. Off unless the user turns it on; nothing is written, logged, cached or returned.
_GROK_HOSTS = frozenset({"cli-chat-proxy.grok.com", "grok.com", "api.x.ai"})
_COMPAT_ENV = "HERMES_PROVIDER_USAGE_COMPAT_OAUTH"
_COMPAT_SETTING = "compat_oauth_reads"


class _CompatResponse:
    """The fields the xAI readers use. Built from the response only, never from the request."""

    __slots__ = ("status", "headers", "body")

    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status, self.headers, self.body = status, headers, body

    def json(self) -> Any:
        try:
            return json.loads(self.body)
        except ValueError:
            return None


def _compat_enabled() -> bool:
    """Opt-in switch: env var, or ``compat_oauth_reads`` in the profile's settings file."""
    if os.getenv(_COMPAT_ENV, "").strip().lower() in {"1", "true", "yes", "on"}:
        return True
    return _read_settings().get(_COMPAT_SETTING) is True


def _compat_xai_request(
    method: str,
    url: str,
    *,
    headers: Optional[dict[str, str]] = None,
    content: Optional[bytes] = None,
    timeout: float = 15.0,
) -> _CompatResponse:
    """Use core's resolver and send one request, when the build has no broker route.

    The access token lives in this frame for the duration of the call. It is never logged,
    cached, persisted or returned, the host is checked here rather than trusted from the
    caller, and every failure is rebuilt as a message with a type name only.
    """
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or host not in _GROK_HOSTS or parts.username or parts.password:
        raise _XaiAuthFailure("Compatibility mode refuses a request outside xAI's own hosts.")

    try:
        from hermes_cli.auth_xai import resolve_xai_oauth_runtime_credentials
    except ImportError:
        raise _XaiBrokerUnavailable(_GROK_UPGRADE_REASON) from None
    try:
        creds = resolve_xai_oauth_runtime_credentials()
    except Exception as exc:  # AuthError, provider HTTP errors, a malformed store
        raise _XaiAuthFailure(f"xAI sign-in could not be resolved ({type(exc).__name__}).") from None

    token = str(creds.get("api_key") or "").strip()
    if not token:
        raise _XaiAuthFailure("No usable xai-oauth sign-in in this Hermes profile.")
    send = {name: value for name, value in dict(headers or {}).items()
            if name.lower() not in {"authorization", "host", "content-length"}}
    send["Authorization"] = f"Bearer {token}"
    try:
        with httpx.Client(timeout=timeout, follow_redirects=False) as client:
            response = client.request(method, url, headers=send, content=content)
            return _CompatResponse(response.status_code, dict(response.headers), response.content)
    except Exception as exc:
        raise _XaiHTTPFailure(f"xAI request failed ({type(exc).__name__}).") from None
    finally:
        token = send = ""  # drop this frame's references before it unwinds


def _xai_without_broker(
    method: str,
    url: str,
    *,
    headers: Optional[dict[str, str]] = None,
    content: Optional[bytes] = None,
    timeout: float = 15.0,
) -> Any:
    """No broker route on this build: compatibility mode if the user opted in, else explain."""
    if _compat_enabled():
        return _compat_xai_request(method, url, headers=headers, content=content, timeout=timeout)
    raise _XaiBrokerUnavailable(_GROK_UPGRADE_REASON)


def _credentialed_xai_request(
    method: str,
    url: str,
    *,
    headers: Optional[dict[str, str]] = None,
    content: Optional[bytes] = None,
    timeout: float = 15.0,
) -> Any:
    """Call Hermes's broker; the subscription token never enters this process's plugin code."""
    try:
        from hermes_cli.plugin_provider_requests import ProviderNotSignedIn, credentialed_provider_request
    except ImportError:
        return _xai_without_broker(method, url, headers=headers, content=content, timeout=timeout)
    kwargs: dict[str, Any] = {"headers": headers, "timeout": timeout}
    if content is not None:
        kwargs["content"] = content
    try:
        return credentialed_provider_request("xai-oauth", method, url, **kwargs)
    except ProviderNotSignedIn as exc:
        raise _XaiAuthFailure(str(exc)) from None
    except PermissionError as exc:
        raise _XaiAuthFailure(str(exc)) from None
    except TypeError as exc:
        # Older cores expose the helper without ``content=`` (the dbe0bcec
        # bytes-body seam). Do not fall through to a raw token; report upgrade.
        if "unexpected keyword argument" in str(exc):
            return _xai_without_broker(method, url, headers=headers, content=content, timeout=timeout)
        raise
    except ValueError as exc:
        if "No signed-in requests for provider" in str(exc):
            return _xai_without_broker(method, url, headers=headers, content=content, timeout=timeout)
        raise


def _raise_for_xai_status(status: int) -> None:
    if status in (401, 403):
        raise _XaiAuthFailure(f"xAI rejected the Hermes sign-in (HTTP {status}).")
    if status >= 400:
        raise _XaiHTTPFailure(f"xAI endpoint returned HTTP {status}.")


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


def _grok_plan(headers: dict[str, str]) -> Optional[str]:
    try:
        response = _credentialed_xai_request("GET", _GROK_SETTINGS, headers=headers, timeout=2.0)
        _raise_for_xai_status(response.status)
        payload = response.json() or {}
    except Exception:
        # Plan metadata is optional: keep the credits body even if /settings is
        # unavailable. This is not a route fallback, so the no-auth-fallback
        # rule for the billing/credits requests is unaffected.
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


def _fetch_xai_proxy() -> dict[str, Any]:
    headers = {
        "Accept": "application/json",
        "x-xai-token-auth": "xai-grok-cli",
        "User-Agent": "hermes-provider-usage/0.9",
    }
    response = _credentialed_xai_request("GET", _GROK_PROXY, headers=headers, timeout=15.0)
    _raise_for_xai_status(response.status)
    payload = response.json() or {}
    plan = _grok_plan(headers)
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


def _fetch_xai_grpc() -> dict[str, Any]:
    headers = {
        "Content-Type": "application/grpc-web+proto",
        "Accept": "application/grpc-web+proto",
        "X-Grpc-Web": "1",
        "Origin": "https://grok.com",
        "Referer": "https://grok.com/",
        "User-Agent": "hermes-provider-usage/0.9",
    }
    response = _credentialed_xai_request(
        "POST", _GROK_BILLING_GRPC, content=b"\x00\x00\x00\x00\x00", headers=headers, timeout=15.0,
    )
    _raise_for_xai_status(response.status)
    payload = _decode_grpc_web(response.body, httpx.Headers(response.headers))
    plan = _grok_plan({
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


def _fetch_xai() -> dict[str, Any]:
    # The Grok token belongs to Hermes: core attaches it to these exact hosts through the
    # credentialed-provider broker. This module never resolves or holds the OAuth grant.
    try:
        return _fetch_xai_proxy()
    except (_XaiBrokerUnavailable, _XaiAuthFailure) as exc:
        return _unavailable("xai-oauth", str(exc))
    except Exception:
        log.debug("xAI credits proxy unavailable; falling back to grok.com billing", exc_info=True)
    try:
        return _fetch_xai_grpc()
    except (_XaiBrokerUnavailable, _XaiAuthFailure, _XaiHTTPFailure) as exc:
        return _unavailable("xai-oauth", str(exc))


def _fetch_nous() -> dict[str, Any]:
    # Enhanced core exposes a Nous read-only fetcher. Stock 0.23.1 exposes the
    # same account-usage builder (``build_nous_credits_snapshot``) without a
    # ``fetch_account_usage`` entry; its portal helper is core-owned and the
    # plugin never sees a token. Both routes return the same non-secret snapshot.
    snapshot = _core_usage("nous")
    if snapshot is None:
        snapshot = _stock_nous_snapshot()
    if snapshot is None:
        return _provider_unavailable("nous")
    return _serialize_snapshot(snapshot)


def _stock_nous_snapshot() -> Any:
    """Stock-compatible Nous snapshot through core's own builder, or None."""
    builder = _core_helper("build_nous_credits_snapshot")
    portal = _core_helper("_fetch_portal_account")
    if builder is None or portal is None:
        return None
    try:
        account_info = portal(10.0)
        return builder(account_info)
    except Exception:
        log.debug("Nous stock portal snapshot unavailable", exc_info=True)
        return None


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
    # Enhanced core owns both ``/api/usage`` and ``/api/balance`` and returns
    # their decoded bodies on ``raw``. Stock has no Ollama fetcher, so the
    # profile's own OLLAMA_API_KEY may read the same fixed official endpoints.
    snapshot = _core_usage("ollama-cloud")
    if snapshot is not None and isinstance(_snapshot_raw(snapshot).get("usage"), dict):
        return _serialize_snapshot(snapshot)
    direct = _direct_ollama_cloud()
    if direct is not None:
        return direct
    if snapshot is not None:
        return _serialize_snapshot(snapshot)
    return _provider_unavailable("ollama-cloud")


def _direct_ollama_cloud() -> Optional[dict[str, Any]]:
    token = _read_definition_secret("OLLAMA_API_KEY")
    if not token:
        return None
    try:
        usage_response = _fixed_provider_get(
            "https://ollama.com/api/usage", token, host="ollama.com", timeout=15.0,
        )
        usage = usage_response.json() or {}
        if not isinstance(usage, dict):
            return None
        row = _ollama_usage_row(usage)
        try:
            balance_response = _fixed_provider_get(
                "https://ollama.com/api/balance", token, host="ollama.com", timeout=15.0,
            )
            balance = balance_response.json() or {}
            if isinstance(balance, dict) and balance:
                _apply_ollama_balance(row, balance)
        except Exception:
            log.debug("Ollama Cloud balance endpoint unavailable", exc_info=True)
        return _mark_env_read(row, "OLLAMA_API_KEY")
    except Exception:
        log.debug("Ollama Cloud direct env read failed", exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Declarative provider definitions
#
# A definition is versioned JSON data: a fixed HTTPS GET, a credential
# reference (never a literal secret), and path-only mappings into the JSON
# response. There is no eval, no script hook, and no arbitrary header value.
# The bundled catalog ships with the plugin; profile-local files live under
# $HERMES_HOME/provider-usage/providers/*.json and may override a bundled entry
# only with an explicit `"override": true`.
# ---------------------------------------------------------------------------

_DEFINITION_SCHEMA = "hermes.provider-usage.definition/1"
_DEFINITION_APPROVAL_SCHEMA = "hermes.provider-usage.approvals/1"
_PLUGIN_VERSION = "0.10.4"
#: Wall-clock budget for one /overview fan-out. The desktop aborts a plugin request at
#: 25s and then renders "Usage unavailable" with no row at all, so the backend must
#: answer inside that cap even when a provider hangs: unfinished providers become
#: explicit slow rows instead of costing the whole response.
_OVERVIEW_DEADLINE_S = 18.0
#: Last completed overview, for GET /diagnostics. No credential, no row content —
#: only ids, timings, failures and the profile that was read.
_LAST_OVERVIEW: dict[str, Any] = {}


def _failure_summary(exc: BaseException) -> str:
    """One log-safe line for a failed provider read: type plus a bounded message.

    Never includes headers, tokens or response bodies — the message is passed through
    the same redaction used for the user-facing reason.
    """
    detail = _safe_request_error(exc)
    return f"{type(exc).__name__}: {detail}"[:300]

_DEFINITION_MAX_BYTES = 512 * 1024
_DEFINITION_TIMEOUT_SECS = 10.0
_DEFINITION_TOTAL_TIMEOUT_SECS = 20.0
_DEFINITION_DNS_TIMEOUT_SECS = 3.0
_DEFINITION_MAX_ADDRESSES = 8
_DEFINITION_MAX_FILE_BYTES = 128 * 1024
_DEFINITION_APPROVAL_MAX_BYTES = 256 * 1024
_DEFINITION_CACHE: dict[str, dict[str, Any]] = {}
_DEFINITION_CACHE_LOCK = threading.Lock()
_DEFINITION_TRANSPORT: Any = None  # test seam; production leaves this None
_DEFINITION_NAT64_NETWORKS = (
    ipaddress.ip_network("64:ff9b::/96"),
    ipaddress.ip_network("64:ff9b:1::/48"),
)
_DEFINITION_RESERVED_IDS = set(_SUPPORTED) | set(_PROVIDER_LABELS) | {v for v in _ALIASES.values() if v}
_DEFINITION_HOST_RE = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
)
_DEFINITION_PATH_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_DEFINITION_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
_DEFINITION_ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
_DEFINITION_HEADER_RE = re.compile(r"^[A-Za-z0-9-]{1,60}$")
_DEFINITION_UNITS = {"percent", "requests", "tokens", "characters", "usd", "credits", "custom"}
_DEFINITION_WINDOW_KINDS = {"five_hour", "daily", "weekly", "monthly", "rolling", "custom"}
_DEFINITION_BALANCE_UNITS = {"currency", "credits", "custom"}
_DEFINITION_BALANCE_KINDS = {"credit", "wallet", "grant", "custom"}
_DEFINITION_FORBIDDEN_HEADERS = {
    "host", "content-length", "connection", "transfer-encoding", "cookie",
    "set-cookie", "accept", "user-agent", "authorization-fingerprint",
}
_DEFINITION_SECRET_HINTS = re.compile(r"(api[_-]?key|token|secret|password|bearer)", re.IGNORECASE)


class _DefinitionError(Exception):
    """A definition fetch failed in a user-visible, non-secret way."""

    def __init__(self, state: str, message: str) -> None:
        super().__init__(message)
        self.state = state
        self.message = message


def _definition_bundled_dir() -> Path:
    return Path(__file__).resolve().parent / "definitions" / "catalog"


def _hermes_home() -> Path:
    """The effective Hermes home for this request (context override, then env, then default)."""
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        return Path.home() / ".hermes"


def _canonical_home_key() -> str:
    """Canonical, case-normalized identity of the effective Hermes home."""
    try:
        from hermes_constants import get_hermes_home, hermes_home_key

        return hermes_home_key(get_hermes_home())
    except Exception:
        return os.path.normcase(str(_hermes_home().expanduser().resolve(strict=False)))


def _hermes_home_scope() -> str:
    """Short, non-path-leaking scope id used for cache keys and provenance.

    A profile name is not enough: two homes can share a display name, and the
    process-wide default is not an "active" bucket. Hashing the canonical home
    keeps rows from different profiles (or a moved home) out of each other's
    cache while still being stable within one install.
    """
    return "home:" + hashlib.sha256(_canonical_home_key().encode("utf-8")).hexdigest()[:16]


def _definition_profile_dir() -> Path:
    override = str(os.environ.get("HERMES_PROVIDER_USAGE_DEFINITIONS") or "").strip()
    if override:
        return Path(override)
    return _hermes_home() / "provider-usage" / "providers"


def _definition_approval_path(home: Optional[Path] = None) -> Path:
    """Approval manifest lives outside the definition directory and outside packages."""
    return (Path(home) if home is not None else _hermes_home()) / "provider-usage" / "approvals.json"


def _definition_error(errors: list[str], path: str, message: str) -> None:
    errors.append(f"{path}: {message}")


def _definition_unknown_keys(value: dict[str, Any], allowed: set[str], path: str, errors: list[str]) -> None:
    for key in sorted(set(value) - allowed):
        _definition_error(errors, f"{path}.{key}", "unknown key")


def _definition_text(value: Any, path: str, errors: list[str], *, required: bool = False, limit: int = 300) -> Optional[str]:
    if value is None:
        if required:
            _definition_error(errors, path, "is required")
        return None
    if not isinstance(value, str):
        _definition_error(errors, path, "must be a string")
        return None
    text = value.strip()
    if not text:
        if required:
            _definition_error(errors, path, "must not be empty")
        return None
    if len(text) > limit:
        _definition_error(errors, path, f"must be at most {limit} characters")
        return None
    if "\n" in text or "\r" in text:
        _definition_error(errors, path, "must be a single line")
        return None
    return text


def _definition_bool(value: Any, path: str, errors: list[str], *, default: bool) -> bool:
    if value is None:
        return default
    if not isinstance(value, bool):
        _definition_error(errors, path, "must be true or false")
        return default
    return value


def _definition_int(value: Any, path: str, errors: list[str], *, minimum: int, maximum: int) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        _definition_error(errors, path, "must be an integer")
        return None
    if value < minimum or value > maximum:
        _definition_error(errors, path, f"must be between {minimum} and {maximum}")
        return None
    return value


def _definition_affix(value: Any, path: str, errors: list[str]) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        _definition_error(errors, path, "must be a string")
        return None
    if len(value) > 40:
        _definition_error(errors, path, "must be at most 40 characters")
        return None
    if "\n" in value or "\r" in value:
        _definition_error(errors, path, "must not contain line breaks")
        return None
    return value


def _definition_path(value: Any, path: str, errors: list[str]) -> Optional[str]:
    if not isinstance(value, str) or not value.strip():
        _definition_error(errors, path, "must be a dot-separated JSON path")
        return None
    text = value.strip()
    if len(text) > 180:
        _definition_error(errors, path, "path is too long")
        return None
    parts = text.split(".")
    if len(parts) > 8:
        _definition_error(errors, path, "path is too deep (max 8 segments)")
        return None
    for part in parts:
        if part.lower() in {"__proto__", "prototype", "constructor"}:
            _definition_error(errors, path, f"reserved path segment '{part}'")
            return None
        if not _DEFINITION_PATH_RE.fullmatch(part):
            _definition_error(errors, path, f"invalid path segment '{part}' (use letters, digits, _ or -)")
            return None
    return text


def _definition_host(value: Any, path: str, errors: list[str]) -> Optional[str]:
    text = _definition_text(value, path, errors, required=True, limit=253)
    if not text:
        return None
    host = text.lower()
    if host != text:
        _definition_error(errors, path, "must be lowercase")
        return None
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        _definition_error(errors, path, "must be a public DNS hostname, not an IP address")
        return None
    if not _DEFINITION_HOST_RE.fullmatch(host):
        _definition_error(errors, path, "must be a public DNS hostname")
        return None
    if host in {"localhost", "localhost.localdomain"} or host.endswith((".local", ".internal", ".lan", ".home", ".localhost")):
        _definition_error(errors, path, "local/private hostnames are not allowed")
        return None
    return host


def _definition_https_url(value: Any, path: str, errors: list[str]) -> Optional[dict[str, Any]]:
    text = _definition_text(value, path, errors, required=True, limit=500)
    if not text:
        return None
    try:
        parsed = urlsplit(text)
    except ValueError:
        _definition_error(errors, path, "is not a valid URL")
        return None
    if parsed.scheme.lower() != "https":
        _definition_error(errors, path, "must use https")
        return None
    if parsed.username or parsed.password:
        _definition_error(errors, path, "must not contain user information")
        return None
    if parsed.query or parsed.fragment:
        _definition_error(errors, path, "query strings and fragments are not supported (schema v1)")
        return None
    try:
        # urlsplit defers port parsing: a non-numeric or out-of-range port raises
        # ValueError here. One malformed definition must never abort the catalog.
        port = parsed.port
        raw_host = parsed.hostname
    except ValueError:
        _definition_error(errors, path, "has an invalid port")
        return None
    if port not in (None, 443):
        _definition_error(errors, path, "must use the default HTTPS port 443")
        return None
    if not raw_host:
        _definition_error(errors, path, "must include a host")
        return None
    if not parsed.path.startswith("/") or ".." in parsed.path.split("/"):
        _definition_error(errors, path, "must have an absolute path without '..'")
        return None
    host = _definition_host(raw_host, f"{path}.host", errors)
    if not host:
        return None
    return {"url": text, "host": host, "path": parsed.path}


def _definition_field(
    value: Any,
    path: str,
    errors: list[str],
    *,
    kind: str,
    required: bool = False,
) -> Optional[dict[str, Any]]:
    """Validate a path field. kind is string, number, or reset."""
    if value is None:
        if required:
            _definition_error(errors, path, "is required")
        return None
    if isinstance(value, str):
        if kind != "string":
            _definition_error(errors, path, "must be an object with a path")
            return None
        text = _definition_text(value, path, errors, required=True, limit=300)
        return {"value": text} if text else None
    if not isinstance(value, dict):
        _definition_error(errors, path, "must be a string or an object with a path")
        return None
    allowed = {"path", "format", "prefix", "suffix", "value"} if kind == "string" else {"path", "format"}
    _definition_unknown_keys(value, allowed, path, errors)
    if ("path" in value) == ("value" in value):
        _definition_error(errors, path, "needs exactly one of path or value")
        return None
    if "value" in value:
        if kind != "string":
            _definition_error(errors, f"{path}.value", "static values are not allowed for numbers")
            return None
        text = _definition_text(value.get("value"), f"{path}.value", errors, required=True, limit=300)
        return {"value": text} if text else None
    json_path = _definition_path(value.get("path"), f"{path}.path", errors)
    if not json_path:
        return None
    result: dict[str, Any] = {"path": json_path}
    fmt = value.get("format")
    if kind == "number":
        if fmt not in (None, "number"):
            _definition_error(errors, f"{path}.format", "only 'number' is supported")
        result["format"] = "number"
    elif kind == "reset":
        if fmt not in (None, "iso", "unix", "unix_ms"):
            _definition_error(errors, f"{path}.format", "must be iso, unix, or unix_ms")
        result["format"] = fmt or "iso"
    else:
        if fmt is not None:
            _definition_error(errors, f"{path}.format", "format is not supported for text fields")
        prefix = _definition_affix(value.get("prefix"), f"{path}.prefix", errors)
        suffix = _definition_affix(value.get("suffix"), f"{path}.suffix", errors)
        if prefix:
            result["prefix"] = prefix
        if suffix:
            result["suffix"] = suffix
    return result


def _definition_currency(value: Any, path: str, errors: list[str], *, required: bool) -> Optional[dict[str, Any]]:
    if value is None:
        if required:
            _definition_error(errors, path, "is required for money/credit units")
        return None
    if isinstance(value, str):
        text = value.strip().upper()
        if not re.fullmatch(r"[A-Z]{3}", text):
            _definition_error(errors, path, "must be a three-letter currency code")
            return None
        return {"value": text}
    field = _definition_field(value, path, errors, kind="string")
    if field and "value" in field:
        text = str(field["value"]).upper()
        if not re.fullmatch(r"[A-Z]{3}", text):
            _definition_error(errors, path, "must be a three-letter currency code")
            return None
        field["value"] = text
    return field


def _definition_credential(value: Any, path: str, errors: list[str]) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict):
        _definition_error(errors, path, "must be a credential reference object")
        return None
    _definition_unknown_keys(value, {"source", "name", "provider", "field"}, path, errors)
    source = value.get("source")
    if source == "env":
        if "provider" in value or "field" in value:
            _definition_error(errors, path, "env credentials use only source + name")
        name = _definition_text(value.get("name"), f"{path}.name", errors, required=True, limit=64)
        if name and not _DEFINITION_ENV_RE.fullmatch(name):
            _definition_error(errors, f"{path}.name", "must be an environment variable name (A-Z, 0-9, _)")
            return None
        return {"source": "env", "name": name} if name else None
    if source == "hermes_provider":
        # Schema v1 deliberately does not resolve provider OAuth/API credentials
        # for declarative definitions: the public catalog contract only permits
        # agent.secret_scope.get_secret. Existing Hermes credential reuse needs a
        # code-owned adapter (or a future, reviewed credential broker), not a
        # data file that can name an arbitrary provider and field.
        _definition_error(
            errors,
            f"{path}.source",
            "hermes_provider references are not supported yet; use source 'env' "
            "(provider credentials require a code-owned adapter)",
        )
        return None
    _definition_error(errors, f"{path}.source", "must be env")
    return None


def _definition_headers(value: Any, path: str, errors: list[str]) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        _definition_error(errors, path, "must be a list")
        return []
    if len(value) > 6:
        _definition_error(errors, path, "at most 6 headers are supported")
        return []
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        prefix = f"{path}[{index}]"
        if not isinstance(item, dict):
            _definition_error(errors, prefix, "must be an object")
            continue
        _definition_unknown_keys(item, {"name", "credential", "prefix"}, prefix, errors)
        name = _definition_text(item.get("name"), f"{prefix}.name", errors, required=True, limit=60)
        if not name or not _DEFINITION_HEADER_RE.fullmatch(name):
            if name:
                _definition_error(errors, f"{prefix}.name", "is not a valid header name")
            continue
        lowered = name.lower()
        if lowered in _DEFINITION_FORBIDDEN_HEADERS:
            _definition_error(errors, f"{prefix}.name", f"'{name}' is set by the client and cannot be overridden")
            continue
        if lowered in seen:
            _definition_error(errors, f"{prefix}.name", "duplicate header")
            continue
        seen.add(lowered)
        credential = _definition_credential(item.get("credential"), f"{prefix}.credential", errors)
        if not credential:
            continue
        header_prefix = _definition_affix(item.get("prefix"), f"{prefix}.prefix", errors) or ""
        if errors and any(str(error).startswith(f"{prefix}.prefix:") for error in errors):
            continue
        result.append({"name": name, "credential": credential, "prefix": header_prefix or ""})
    return result


def _definition_window(
    value: Any,
    path: str,
    errors: list[str],
    *,
    from_items: bool,
) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict):
        _definition_error(errors, path, "must be an object")
        return None
    allowed = {
        "label", "kind", "rolling", "period_seconds", "unit", "currency",
        "limit", "used", "remaining", "used_percent", "remaining_percent",
        "reset_at", "detail",
    }
    _definition_unknown_keys(value, allowed, path, errors)

    label: Any = None
    if from_items:
        label = _definition_field(value.get("label"), f"{path}.label", errors, kind="string", required=True)
        if not label:
            return None
    else:
        label = _definition_text(value.get("label"), f"{path}.label", errors, required=True, limit=60)
        if not label:
            return None

    kind = value.get("kind") or "custom"
    if kind not in _DEFINITION_WINDOW_KINDS:
        _definition_error(errors, f"{path}.kind", f"must be one of {sorted(_DEFINITION_WINDOW_KINDS)}")
        kind = "custom"
    # Only a window explicitly declared as `rolling` is rolling by default.
    # Daily/weekly/monthly windows are fixed periods even when the provider
    # omits a reset time; claiming "rolling" would invent semantics.
    rolling = _definition_bool(value.get("rolling"), f"{path}.rolling", errors, default=kind == "rolling")
    period = None
    if value.get("period_seconds") is not None:
        period = _definition_int(value.get("period_seconds"), f"{path}.period_seconds", errors, minimum=60, maximum=31_536_000)
    unit = value.get("unit") or "percent"
    if unit not in _DEFINITION_UNITS:
        _definition_error(errors, f"{path}.unit", f"must be one of {sorted(_DEFINITION_UNITS)}")
        unit = "custom"
    currency = _definition_currency(value.get("currency"), f"{path}.currency", errors, required=unit in {"usd", "credits"})

    numeric = {}
    for key in ("limit", "used", "remaining", "used_percent", "remaining_percent"):
        field = _definition_field(value.get(key), f"{path}.{key}", errors, kind="number")
        if field:
            numeric[key] = field
    if not numeric:
        _definition_error(errors, path, "needs at least one of limit, used, remaining, used_percent, remaining_percent")
    reset = _definition_field(value.get("reset_at"), f"{path}.reset_at", errors, kind="reset")
    detail = _definition_field(value.get("detail"), f"{path}.detail", errors, kind="string")

    window: dict[str, Any] = {
        "label": label,
        "kind": kind,
        "rolling": rolling,
        "unit": unit,
        "numeric": numeric,
        "reset_at": reset,
        "detail": detail,
    }
    if period is not None:
        window["period_seconds"] = period
    if currency:
        window["currency"] = currency
    return window


def _definition_balance(value: Any, path: str, errors: list[str]) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict):
        _definition_error(errors, path, "must be an object")
        return None
    _definition_unknown_keys(value, {"label", "amount", "currency", "unit", "kind", "detail"}, path, errors)
    label = _definition_text(value.get("label"), f"{path}.label", errors, required=True, limit=60)
    if not label:
        return None
    amount = _definition_field(value.get("amount"), f"{path}.amount", errors, kind="number", required=True)
    if not amount:
        return None
    unit = value.get("unit") or "currency"
    if unit not in _DEFINITION_BALANCE_UNITS:
        _definition_error(errors, f"{path}.unit", f"must be one of {sorted(_DEFINITION_BALANCE_UNITS)}")
        unit = "currency"
    kind = value.get("kind") or "credit"
    if kind not in _DEFINITION_BALANCE_KINDS:
        _definition_error(errors, f"{path}.kind", f"must be one of {sorted(_DEFINITION_BALANCE_KINDS)}")
        kind = "credit"
    currency = _definition_currency(value.get("currency"), f"{path}.currency", errors, required=True)
    detail = _definition_field(value.get("detail"), f"{path}.detail", errors, kind="string")
    return {
        "label": label,
        "amount": amount,
        "currency": currency,
        "unit": unit,
        "kind": kind,
        "detail": detail,
    }


def _definition_detail(value: Any, path: str, errors: list[str]) -> Optional[dict[str, Any]]:
    if isinstance(value, str):
        text = _definition_text(value, path, errors, required=True, limit=200)
        return {"value": text} if text else None
    if not isinstance(value, dict):
        _definition_error(errors, path, "must be a string or an object")
        return None
    _definition_unknown_keys(value, {"path", "value", "prefix", "suffix"}, path, errors)
    if ("path" in value) == ("value" in value):
        _definition_error(errors, path, "needs exactly one of path or value")
        return None
    if "value" in value:
        text = _definition_text(value.get("value"), f"{path}.value", errors, required=True, limit=200)
        return {"value": text} if text else None
    json_path = _definition_path(value.get("path"), f"{path}.path", errors)
    if not json_path:
        return None
    prefix = _definition_affix(value.get("prefix"), f"{path}.prefix", errors)
    suffix = _definition_affix(value.get("suffix"), f"{path}.suffix", errors)
    result: dict[str, Any] = {"path": json_path}
    if prefix:
        result["prefix"] = prefix
    if suffix:
        result["suffix"] = suffix
    return result


def _validate_definition(
    raw: Any,
    *,
    source: str,
    allow_override: bool,
) -> tuple[Optional[dict[str, Any]], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(raw, dict):
        return None, ["definition: must be a JSON object"], warnings
    allowed = {
        "schema", "id", "name", "description", "version", "docs_url",
        "request", "cache_ttl_seconds", "mapping", "scope_note",
        "stability", "override", "author", "license",
    }
    _definition_unknown_keys(raw, allowed, "definition", errors)

    if raw.get("schema") != _DEFINITION_SCHEMA:
        _definition_error(errors, "schema", f"must be '{_DEFINITION_SCHEMA}'")
    ident = _definition_text(raw.get("id"), "id", errors, required=True, limit=40)
    if ident and not _DEFINITION_SLUG_RE.fullmatch(ident):
        _definition_error(errors, "id", "must be a lowercase slug (letters, digits, hyphen)")
        ident = None
    if ident and (_canonical(ident) in _SUPPORTED or ident in _DEFINITION_RESERVED_IDS):
        _definition_error(errors, "id", f"'{ident}' is reserved for a built-in provider; choose a unique id")
    name = _definition_text(raw.get("name"), "name", errors, required=True, limit=80)
    description = _definition_text(raw.get("description"), "description", errors, limit=400)
    version = _definition_int(raw.get("version"), "version", errors, minimum=1, maximum=9999)
    docs_url = _definition_https_url(raw.get("docs_url"), "docs_url", errors)
    scope_note = _definition_text(raw.get("scope_note"), "scope_note", errors, limit=200)
    stability = raw.get("stability") or "experimental"
    if stability not in {"stable", "experimental"}:
        _definition_error(errors, "stability", "must be stable or experimental")
        stability = "experimental"
    author = _definition_text(raw.get("author"), "author", errors, limit=80)
    license_name = _definition_text(raw.get("license"), "license", errors, limit=40)
    override = raw.get("override", False)
    if not isinstance(override, bool):
        _definition_error(errors, "override", "must be true or false")
        override = False
    if override and not allow_override:
        _definition_error(errors, "override", "is only allowed for profile-local definitions")
    if not override and allow_override:
        pass

    request_raw = raw.get("request")
    request: Optional[dict[str, Any]] = None
    if not isinstance(request_raw, dict):
        _definition_error(errors, "request", "must be an object")
    else:
        _definition_unknown_keys(request_raw, {"url", "method", "hosts", "headers"}, "request", errors)
        url = _definition_https_url(request_raw.get("url"), "request.url", errors)
        method = request_raw.get("method") or "GET"
        if method != "GET":
            _definition_error(errors, "request.method", "only GET is supported (read-only schema v1)")
        hosts_raw = request_raw.get("hosts")
        hosts: list[str] = []
        if not isinstance(hosts_raw, list) or not hosts_raw:
            _definition_error(errors, "request.hosts", "must be a non-empty list of HTTPS hosts")
        else:
            if len(hosts_raw) > 4:
                _definition_error(errors, "request.hosts", "at most 4 hosts are supported")
            for index, item in enumerate(hosts_raw[:4]):
                host = _definition_host(item, f"request.hosts[{index}]", errors)
                if host and host not in hosts:
                    hosts.append(host)
        if url and url["host"] not in hosts:
            _definition_error(errors, "request.hosts", f"must include the request host '{url['host']}'")
        headers = _definition_headers(request_raw.get("headers"), "request.headers", errors)
        if url and method == "GET":
            request = {"url": url["url"], "host": url["host"], "path": url["path"], "method": "GET", "headers": headers}

    ttl = raw.get("cache_ttl_seconds", 300)
    if isinstance(ttl, bool) or not isinstance(ttl, int):
        _definition_error(errors, "cache_ttl_seconds", "must be an integer")
        ttl = 300
    elif ttl < 30 or ttl > 86_400:
        _definition_error(errors, "cache_ttl_seconds", "must be between 30 and 86400 seconds")
        ttl = 300

    mapping_raw = raw.get("mapping")
    mapping: Optional[dict[str, Any]] = None
    if not isinstance(mapping_raw, dict):
        _definition_error(errors, "mapping", "must be an object")
    else:
        _definition_unknown_keys(mapping_raw, {"title", "plan", "scope_note", "windows", "windows_from", "balances", "details"}, "mapping", errors)
        title = _definition_text(mapping_raw.get("title"), "mapping.title", errors, limit=80)
        plan = _definition_field(mapping_raw.get("plan"), "mapping.plan", errors, kind="string")
        mapping_scope = _definition_text(mapping_raw.get("scope_note"), "mapping.scope_note", errors, limit=200)
        windows: list[dict[str, Any]] = []
        windows_from: Optional[dict[str, Any]] = None
        if mapping_raw.get("windows") is not None and mapping_raw.get("windows_from") is not None:
            _definition_error(errors, "mapping", "use either windows or windows_from, not both")
        elif mapping_raw.get("windows") is not None:
            raw_windows = mapping_raw.get("windows")
            if not isinstance(raw_windows, list) or not raw_windows:
                _definition_error(errors, "mapping.windows", "must be a non-empty list")
            else:
                if len(raw_windows) > 12:
                    _definition_error(errors, "mapping.windows", "at most 12 windows are supported")
                for index, item in enumerate(raw_windows[:12]):
                    window = _definition_window(item, f"mapping.windows[{index}]", errors, from_items=False)
                    if window:
                        windows.append(window)
        elif mapping_raw.get("windows_from") is not None:
            raw_from = mapping_raw.get("windows_from")
            if not isinstance(raw_from, dict):
                _definition_error(errors, "mapping.windows_from", "must be an object")
            else:
                _definition_unknown_keys(
                    raw_from,
                    {"path", "label", "kind", "rolling", "period_seconds", "unit", "currency", "limit", "used", "remaining", "used_percent", "remaining_percent", "reset_at", "detail"},
                    "mapping.windows_from",
                    errors,
                )
                item_path = _definition_path(raw_from.get("path"), "mapping.windows_from.path", errors)
                if item_path:
                    spec = {key: value for key, value in raw_from.items() if key != "path"}
                    window = _definition_window(spec, "mapping.windows_from", errors, from_items=True)
                    if window:
                        windows_from = {"path": item_path, "spec": window}
        balances: list[dict[str, Any]] = []
        raw_balances = mapping_raw.get("balances")
        if raw_balances is not None:
            if not isinstance(raw_balances, list):
                _definition_error(errors, "mapping.balances", "must be a list")
            else:
                if len(raw_balances) > 10:
                    _definition_error(errors, "mapping.balances", "at most 10 balances are supported")
                for index, item in enumerate(raw_balances[:10]):
                    balance = _definition_balance(item, f"mapping.balances[{index}]", errors)
                    if balance:
                        balances.append(balance)
        details: list[dict[str, Any]] = []
        raw_details = mapping_raw.get("details")
        if raw_details is not None:
            if not isinstance(raw_details, list):
                _definition_error(errors, "mapping.details", "must be a list")
            else:
                if len(raw_details) > 20:
                    _definition_error(errors, "mapping.details", "at most 20 details are supported")
                for index, item in enumerate(raw_details[:20]):
                    detail = _definition_detail(item, f"mapping.details[{index}]", errors)
                    if detail:
                        details.append(detail)
        if not windows and not windows_from and not balances:
            _definition_error(errors, "mapping", "must map at least one window or balance")
        if windows and windows_from:
            _definition_error(errors, "mapping", "windows and windows_from cannot both be present")
        mapping = {
            "title": title,
            "plan": plan,
            "scope_note": mapping_scope,
            "windows": windows,
            "windows_from": windows_from,
            "balances": balances,
            "details": details,
        }

    if errors:
        return None, errors, warnings

    definition = {
        "schema": _DEFINITION_SCHEMA,
        "id": ident,
        "name": name,
        "description": description,
        "version": version,
        "docs_url": docs_url["url"] if docs_url else None,
        "request": request,
        "cache_ttl_seconds": ttl,
        "mapping": mapping,
        "scope_note": scope_note,
        "stability": stability,
        "author": author,
        "license": license_name,
        "override": override,
    }
    definition["_source"] = source
    try:
        definition["_digest"] = _definition_digest(definition)
    except (TypeError, ValueError, RecursionError):
        return None, errors + [
            "definition: could not fingerprint the definition (unsupported value or excessive nesting)"
        ], warnings
    return definition, errors, warnings


def _definition_digest(definition: dict[str, Any]) -> str:
    payload = {key: value for key, value in definition.items() if not key.startswith("_")}
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _definition_credential_refs(definition: dict[str, Any]) -> list[dict[str, str]]:
    """Structured, non-secret credential references in request-header order."""
    refs: list[dict[str, str]] = []
    seen: set[str] = set()
    for spec in (definition.get("request") or {}).get("headers") or []:
        ref = spec.get("credential") or {}
        item: dict[str, str] = {}
        if ref.get("source") == "env" and ref.get("name"):
            item = {"source": "env", "name": str(ref["name"])}
        elif ref.get("source") == "hermes_provider" and ref.get("provider") and ref.get("field"):
            item = {
                "source": "hermes_provider",
                "provider": str(ref["provider"]),
                "field": str(ref["field"]),
            }
        if not item:
            continue
        key = json.dumps(item, sort_keys=True, separators=(",", ":"))
        if key not in seen:
            seen.add(key)
            refs.append(item)
    return refs


def _credential_refs_key(refs: Any) -> str:
    return json.dumps(refs if isinstance(refs, list) else [], sort_keys=True, separators=(",", ":"))


def _definition_credential_labels(definition: dict[str, Any]) -> list[str]:
    return [
        str(ref["name"]) if ref.get("source") == "env" else f"{ref.get('provider')}.{ref.get('field')}"
        for ref in _definition_credential_refs(definition)
    ]


_DEFINITION_APPROVAL_LOCK = threading.Lock()


def _load_definition_approvals(*, home: Optional[Path] = None) -> tuple[dict[str, dict[str, Any]], Optional[str]]:
    """Read the local approval manifest. Fail closed: a corrupt manifest blocks.

    Returns ``(approvals, error)``. No secret is read during approval or trust
    evaluation; the manifest only contains the fingerprint, destination, and
    credential *references*.
    """
    path = _definition_approval_path(home)
    if not path.exists():
        return {}, None
    try:
        size = path.stat().st_size
        if size > _DEFINITION_APPROVAL_MAX_BYTES:
            return {}, (
                f"Approval manifest {path.name} is {size} bytes; the limit is "
                f"{_DEFINITION_APPROVAL_MAX_BYTES} bytes. Profile definitions are blocked until it is fixed."
            )
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        return {}, (
            f"Approval manifest {path.name} could not be read ({type(exc).__name__}). "
            "Profile definitions are blocked until it is fixed."
        )
    if not isinstance(raw, dict) or raw.get("schema") != _DEFINITION_APPROVAL_SCHEMA:
        return {}, (
            f"Approval manifest {path.name} is invalid (expected schema '{_DEFINITION_APPROVAL_SCHEMA}'). "
            "Profile definitions are blocked until it is fixed."
        )
    raw_approvals = raw.get("approvals")
    if not isinstance(raw_approvals, dict):
        return {}, f"Approval manifest {path.name} is invalid ('approvals' must be an object). Profile definitions are blocked."
    approvals: dict[str, dict[str, Any]] = {}
    for ident, item in raw_approvals.items():
        if not isinstance(ident, str) or not ident or not isinstance(item, dict):
            return {}, f"Approval manifest {path.name} has an invalid entry. Profile definitions are blocked."
        digest = item.get("digest")
        endpoint = item.get("endpoint")
        refs = item.get("credential_refs")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            return {}, f"Approval manifest {path.name} has an invalid digest for '{ident}'. Profile definitions are blocked."
        if not isinstance(endpoint, str) or not endpoint.strip():
            return {}, f"Approval manifest {path.name} has an invalid endpoint for '{ident}'. Profile definitions are blocked."
        if not isinstance(refs, list) or not all(isinstance(ref, dict) for ref in refs):
            return {}, f"Approval manifest {path.name} has invalid credential_refs for '{ident}'. Profile definitions are blocked."
        approvals[ident] = {
            "digest": digest,
            "endpoint": endpoint.strip(),
            "credential_refs": refs,
            "approved_at": item.get("approved_at"),
            "approved_by": item.get("approved_by"),
        }
    return approvals, None


def _definition_trust(
    definition: dict[str, Any],
    *,
    approvals: Optional[dict[str, dict[str, Any]]] = None,
    approval_error: Optional[str] = None,
) -> tuple[str, str]:
    """Classify a definition as approved, untrusted, or blocked.

    Bundled definitions are code-owned and reviewed with the plugin. Every
    profile-local definition (including an ``override`` of a bundled id) must
    match a local approval record exactly: content digest, endpoint, and the
    structured credential references. Any change revokes the approval.
    """
    if definition.get("_source") == "bundled":
        return "approved", ""
    if approvals is None:
        approvals, approval_error = _load_definition_approvals()
    if approval_error:
        return "blocked", approval_error
    ident = str(definition.get("id") or "")
    record = approvals.get(ident)
    if record is None:
        return (
            "untrusted",
            "This profile definition has not been approved on this machine. "
            "Review its destination and credential references, then run scripts/approve_definition.py.",
        )
    if record.get("digest") != definition.get("_digest"):
        return (
            "blocked",
            "The definition changed after it was approved, so its approval was revoked. "
            "Review the new content and approve it again.",
        )
    endpoint = str((definition.get("request") or {}).get("url") or "")
    if record.get("endpoint") != endpoint:
        return "blocked", "The approval record's endpoint does not match the definition. Review and approve it again."
    if _credential_refs_key(record.get("credential_refs")) != _credential_refs_key(
        _definition_credential_refs(definition)
    ):
        return "blocked", "The approval record's credential references do not match the definition. Review and approve it again."
    return "approved", ""


def _definition_approval_preview(definition: dict[str, Any]) -> dict[str, Any]:
    """Everything a human needs to approve, with no secret values and no reads."""
    request = definition.get("request") or {}
    refs = _definition_credential_refs(definition)
    return {
        "id": definition.get("id"),
        "name": definition.get("name"),
        "version": definition.get("version"),
        "file": definition.get("_file") or "",
        "endpoint": request.get("url") or "",
        "host": request.get("host") or "",
        "credential_refs": refs,
        "credential_labels": _definition_credential_labels(definition),
        "digest": definition.get("_digest") or "",
        # Relative on purpose: catalog rows cross the REST boundary and should
        # not leak the local user's home path. The CLI prints the absolute path.
        "approvals_file": "provider-usage/approvals.json",
    }


def _definition_approval_view(definition: dict[str, Any], trust: str, reason: str = "") -> dict[str, Any]:
    """Non-secret approval metadata for a row or catalog entry."""
    view = _definition_approval_preview(definition)
    view["required"] = trust != "approved"
    view["approved"] = trust == "approved"
    if reason:
        view["reason"] = reason
    return view


def write_definition_approval(definition: dict[str, Any], *, home: Optional[Path] = None) -> dict[str, Any]:
    """Bind this exact definition content to the local approval manifest.

    This function never reads a credential. The caller (the local CLI) is
    responsible for showing the destination and references and obtaining an
    explicit human confirmation before calling it.
    """
    if definition.get("_source") == "bundled":
        raise ValueError("bundled definitions are code-owned and do not need a local approval")
    if not definition.get("_digest"):
        raise ValueError("definition has no fingerprint; validate it before approving")
    if (definition.get("request") or {}).get("path") is None:
        raise ValueError("definition request is invalid; validate it before approving")
    entry = {
        "digest": str(definition["_digest"]),
        "endpoint": str((definition.get("request") or {}).get("url") or ""),
        "credential_refs": _definition_credential_refs(definition),
        "approved_at": _now(),
        "approved_by": "local-user",
    }
    path = _definition_approval_path(home)
    with _DEFINITION_APPROVAL_LOCK:
        approvals, error = _load_definition_approvals(home=home)
        if error:
            raise ValueError(error)
        approvals[str(definition["id"])] = entry
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"schema": _DEFINITION_APPROVAL_SCHEMA, "approvals": approvals}
        text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(text, encoding="utf-8")
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass  # Windows has no POSIX mode bits; the file stays user-owned.
        os.replace(temporary, path)
    return entry


def remove_definition_approval(definition_id: str, *, home: Optional[Path] = None) -> bool:
    """Revoke one local approval. Returns True when a record was removed."""
    path = _definition_approval_path(home)
    with _DEFINITION_APPROVAL_LOCK:
        approvals, error = _load_definition_approvals(home=home)
        if error:
            raise ValueError(error)
        if definition_id not in approvals:
            return False
        approvals.pop(definition_id, None)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"schema": _DEFINITION_APPROVAL_SCHEMA, "approvals": approvals}
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, path)
    return True


def _definition_file_entry(path: Path, *, source: str, allow_override: bool) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": path.stem,
        "name": path.stem.replace("-", " ").title(),
        "file": path.name,
        "source": source,
        "errors": [],
        "warnings": [],
        "definition": None,
    }
    try:
        size = path.stat().st_size
        if size > _DEFINITION_MAX_FILE_BYTES:
            entry["errors"] = [f"file: is {size} bytes; the limit is {_DEFINITION_MAX_FILE_BYTES} bytes"]
            return entry
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        entry["errors"] = [f"file: could not read JSON ({type(exc).__name__})"]
        return entry
    if isinstance(raw, dict):
        entry["id"] = str(raw.get("id") or path.stem).strip() or path.stem
        entry["name"] = str(raw.get("name") or entry["id"]).strip() or entry["id"]
    try:
        definition, errors, warnings = _validate_definition(raw, source=source, allow_override=allow_override)
    except Exception as exc:  # one pathological file must not take down the catalog
        entry["errors"] = [f"file: validation failed unexpectedly ({type(exc).__name__})"]
        return entry
    entry["errors"] = errors
    entry["warnings"] = warnings
    if definition:
        definition["_file"] = path.name
        entry["definition"] = definition
    return entry


def _definition_files(directory: Path, *, source: str, allow_override: bool) -> list[dict[str, Any]]:
    try:
        if not directory.exists() or not directory.is_dir():
            return []
        paths = sorted(directory.glob("*.json"), key=lambda item: item.name.lower())
    except OSError:
        return []
    entries = []
    for path in paths:
        try:
            if not path.is_file():
                continue
            entries.append(_definition_file_entry(path, source=source, allow_override=allow_override))
        except Exception as exc:  # filesystem race, permissions, pathological input
            entries.append({
                "id": path.stem,
                "name": path.stem.replace("-", " ").title(),
                "file": path.name,
                "source": source,
                "errors": [f"file: could not be inspected ({type(exc).__name__})"],
                "warnings": [],
                "definition": None,
            })
    return entries


def _load_provider_definitions() -> dict[str, Any]:
    bundled_dir = _definition_bundled_dir()
    profile_dir = _definition_profile_dir()
    bundled = _definition_files(bundled_dir, source="bundled", allow_override=False)
    profile = _definition_files(profile_dir, source="profile", allow_override=True)

    valid: dict[str, dict[str, Any]] = {}
    invalid: list[dict[str, Any]] = []
    bundled_ids: set[str] = set()

    for entry in bundled:
        if not entry["definition"]:
            invalid.append(entry)
            continue
        ident = entry["definition"]["id"]
        if ident in valid:
            entry["errors"] = [f"id: duplicate bundled definition '{ident}'"]
            invalid.append(entry)
            continue
        bundled_ids.add(ident)
        valid[ident] = entry

    profile_seen: set[str] = set()
    for entry in profile:
        if not entry["definition"]:
            invalid.append(entry)
            continue
        definition = entry["definition"]
        ident = definition["id"]
        if ident in profile_seen:
            entry["errors"] = [f"id: duplicate profile definition '{ident}' (first file wins)"]
            invalid.append(entry)
            continue
        profile_seen.add(ident)
        if ident in bundled_ids:
            if not definition.get("override"):
                entry["errors"] = [
                    f"id: collides with bundled definition '{ident}'; rename it or set \"override\": true to replace the bundled entry"
                ]
                invalid.append(entry)
                continue
            definition["_overrides"] = "bundled"
            entry["overrides"] = "bundled"
            valid[ident] = entry
            continue
        if ident in valid:
            entry["errors"] = [f"id: duplicate definition '{ident}'"]
            invalid.append(entry)
            continue
        valid[ident] = entry

    return {
        "valid": valid,
        "invalid": invalid,
        "bundled_dir": bundled_dir,
        "profile_dir": profile_dir,
        "bundled_count": len(bundled),
        "profile_count": len(profile),
    }


def _read_definition_secret(name: str) -> Optional[str]:
    """Read one credential through Hermes' profile-scoped secret API.

    Never falls back to ``os.environ``: that would bypass the multiplexing
    gateway's per-profile secret scope and could read another profile's value.
    A missing API or an unresolvable scope is treated as "no value", never as a
    reason to widen the read.
    """
    try:
        from agent.secret_scope import get_secret
    except Exception:
        return None
    try:
        value = get_secret(name)
    except Exception:
        return None
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or chr(13) in value or chr(10) in value:
        # A credential with a line break cannot be a safe header value; treat it
        # as missing rather than letting it split the request.
        return None
    return value


def _credential_value(ref: dict[str, Any]) -> Optional[str]:
    if ref.get("source") != "env":
        return None
    name = str(ref.get("name") or "").strip()
    if not name:
        return None
    return _read_definition_secret(name)


def _credential_label(ref: dict[str, Any]) -> str:
    if ref.get("source") == "env":
        return str(ref.get("name") or "environment variable")
    return f"{ref.get('provider')}.{ref.get('field')}"


def _resolve_definition_headers(definition: dict[str, Any]) -> tuple[dict[str, str], list[str]]:
    headers: dict[str, str] = {}
    missing: list[str] = []
    for spec in definition["request"].get("headers") or []:
        ref = spec.get("credential") or {}
        value = _credential_value(ref)
        if not value:
            missing.append(_credential_label(ref))
            continue
        headers[str(spec["name"])] = f"{spec.get('prefix') or ''}{value}"
    return headers, missing


def _definition_endpoint_host(definition: dict[str, Any]) -> str:
    return str(definition["request"].get("host") or "")


def _classify_public_address(host: str, address: str) -> str:
    """Return a normalized public IP literal or raise a blocked error."""
    cleaned = str(address).split("%", 1)[0]
    try:
        parsed = ipaddress.ip_address(cleaned)
    except ValueError as exc:
        raise _DefinitionError("blocked", f"{host} resolved to an invalid address; the request was refused.") from exc
    if isinstance(parsed, ipaddress.IPv6Address):
        if parsed.ipv4_mapped is not None:
            raise _DefinitionError("blocked", f"{host} resolved to an IPv4-mapped IPv6 address; the request was refused.")
        if any(parsed in network for network in _DEFINITION_NAT64_NETWORKS):
            raise _DefinitionError("blocked", f"{host} resolved to a NAT64 address; the request was refused.")
    if (
        not parsed.is_global
        or parsed.is_private
        or parsed.is_loopback
        or parsed.is_link_local
        or parsed.is_multicast
        or parsed.is_reserved
        or parsed.is_unspecified
    ):
        raise _DefinitionError(
            "blocked",
            f"{host} resolves to a non-public address ({cleaned}); local/private requests are refused.",
        )
    return str(parsed)


def _resolve_public_addresses(host: str) -> list[str]:
    """Resolve once, under a hard wall-clock bound, and vet every answer.

    The returned addresses are the only addresses the request may use. Mixed
    public/private answers are refused entirely so a round-robin rebind cannot
    pick a private peer on a second connection.
    """
    outcome: dict[str, Any] = {}

    def _lookup() -> None:
        try:
            outcome["infos"] = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        except BaseException as exc:  # socket.gaierror, OSError, or a resolver bug
            outcome["error"] = exc

    worker = threading.Thread(target=_lookup, name="provider-usage-dns", daemon=True)
    worker.start()
    worker.join(max(0.1, float(_DEFINITION_DNS_TIMEOUT_SECS)))
    if worker.is_alive():
        raise _DefinitionError(
            "unavailable",
            f"DNS lookup for {host} did not finish within {_DEFINITION_DNS_TIMEOUT_SECS:.0f}s.",
        )
    error = outcome.get("error")
    if isinstance(error, BaseException):
        raise _DefinitionError(
            "unavailable",
            f"Could not resolve {host}; check the definition's host and this machine's DNS.",
        ) from error
    infos = outcome.get("infos") or []
    if not infos:
        raise _DefinitionError("unavailable", f"Could not resolve {host}.")
    addresses: list[str] = []
    for info in infos:
        address = _classify_public_address(host, str(info[4][0]))
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise _DefinitionError("blocked", f"{host} did not resolve to a public address; the request was refused.")
    return addresses[:_DEFINITION_MAX_ADDRESSES]


def _definition_pinned_target(definition: dict[str, Any], address: str) -> str:
    literal = f"[{address}]" if ":" in address else address
    path = str((definition.get("request") or {}).get("path") or "/")
    if not path.startswith("/"):
        path = "/" + path
    return f"https://{literal}:443{path}"


def _definition_request_json(
    definition: dict[str, Any],
    headers: dict[str, str],
    *,
    transport: Any = None,
) -> Any:
    trust, trust_reason = _definition_trust(definition)
    if trust != "approved":
        raise _DefinitionError("blocked" if trust == "blocked" else "requires_approval", trust_reason)
    host = _definition_endpoint_host(definition)
    if not host:
        raise _DefinitionError("blocked", "The definition has no request host.")
    deadline = time.monotonic() + float(_DEFINITION_TOTAL_TIMEOUT_SECS)
    addresses = _resolve_public_addresses(host)
    # Connect to the vetted address, never to a second resolution of the name.
    # The TLS SNI name and Host header stay the definition host, so certificate
    # verification and virtual hosting are unchanged.
    pinned_url = _definition_pinned_target(definition, addresses[0])
    if transport is None:
        transport = _DEFINITION_TRANSPORT
    remaining = max(0.1, deadline - time.monotonic())
    timeout = httpx.Timeout(
        connect=min(5.0, remaining),
        read=min(float(_DEFINITION_TIMEOUT_SECS), remaining),
        write=min(float(_DEFINITION_TIMEOUT_SECS), remaining),
        pool=min(float(_DEFINITION_TIMEOUT_SECS), remaining),
    )
    request_headers = {
        "accept": "application/json",
        "user-agent": f"hermes-provider-usage/{_PLUGIN_VERSION}",
        "Host": host,
    }
    request_headers.update(headers)
    request_headers["Host"] = host  # definition headers cannot override this
    kwargs: dict[str, Any] = {
        "follow_redirects": False,
        "trust_env": False,  # no proxy/netrc surprises; the pinned peer is the real peer
        "timeout": timeout,
    }
    if transport is not None:
        kwargs["transport"] = transport
    try:
        if time.monotonic() >= deadline:
            raise _DefinitionError("unavailable", f"Provider request exceeded its {_DEFINITION_TOTAL_TIMEOUT_SECS:.0f}s total deadline.")
        with httpx.Client(**kwargs) as client:
            with client.stream(
                "GET",
                pinned_url,
                headers=request_headers,
                extensions={"sni_hostname": host},
            ) as response:
                status = response.status_code
                if 300 <= status < 400:
                    raise _DefinitionError("unavailable", "Provider redirected the request; redirects are not followed (credentials are never forwarded).")
                if status in (401, 403):
                    raise _DefinitionError("needs_permission", f"Provider refused access (HTTP {status}); check the credential reference, its scope, and its permissions.")
                if status == 429:
                    raise _DefinitionError("unavailable", "Provider rate-limited this account (HTTP 429); try again later.")
                if status >= 400:
                    raise _DefinitionError("unavailable", f"Provider returned HTTP {status}.")
                content_length = response.headers.get("content-length")
                if content_length and content_length.isdigit() and int(content_length) > _DEFINITION_MAX_BYTES:
                    raise _DefinitionError("unavailable", f"Provider response is larger than the {_DEFINITION_MAX_BYTES // 1024} KiB limit.")
                content_type = str(response.headers.get("content-type") or "").lower()
                if content_type and "json" not in content_type:
                    raise _DefinitionError("unavailable", "Provider did not return JSON (content-type check).")
                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_bytes():
                    if time.monotonic() >= deadline:
                        raise _DefinitionError(
                            "unavailable",
                            f"Provider response exceeded the {_DEFINITION_TOTAL_TIMEOUT_SECS:.0f}s total deadline.",
                        )
                    total += len(chunk)
                    if total > _DEFINITION_MAX_BYTES:
                        raise _DefinitionError("unavailable", f"Provider response exceeded the {_DEFINITION_MAX_BYTES // 1024} KiB limit.")
                    chunks.append(chunk)
                body = b"".join(chunks)
                if time.monotonic() >= deadline:
                    raise _DefinitionError(
                        "unavailable",
                        f"Provider request exceeded the {_DEFINITION_TOTAL_TIMEOUT_SECS:.0f}s total deadline.",
                    )
    except _DefinitionError:
        raise
    except httpx.TimeoutException as exc:
        if time.monotonic() >= deadline:
            raise _DefinitionError("unavailable", f"Provider request exceeded the {_DEFINITION_TOTAL_TIMEOUT_SECS:.0f}s total deadline.") from exc
        raise _DefinitionError("unavailable", f"Provider request timed out after {_DEFINITION_TIMEOUT_SECS:.0f}s.") from exc
    except httpx.RequestError as exc:
        raise _DefinitionError("unavailable", "Provider request failed before a response was received.") from exc
    if not body:
        raise _DefinitionError("unavailable", "Provider returned an empty response.")
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise _DefinitionError("unavailable", "Provider returned invalid JSON.") from exc
    if not isinstance(payload, (dict, list)):
        raise _DefinitionError("unavailable", "Provider JSON must be an object or an array.")
    return payload


def _path_get(payload: Any, path: str) -> Any:
    current = payload
    for part in path.split("."):
        if isinstance(current, dict):
            if part not in current:
                return None
            current = current[part]
        elif isinstance(current, list):
            if not part.isdigit():
                return None
            index = int(part)
            if index >= len(current):
                return None
            current = current[index]
        else:
            return None
    return current


def _definition_scalar(spec: Any, payload: Any, *, numeric: bool = False, reset: bool = False) -> Any:
    if spec is None:
        return None
    if isinstance(spec, str):
        return spec.strip() or None
    if not isinstance(spec, dict):
        return None
    if "value" in spec:
        value = spec.get("value")
        if numeric or reset:
            return None
        text = str(value or "").strip()
        return text or None
    value = _path_get(payload, str(spec.get("path") or ""))
    if value is None:
        return None
    if numeric:
        return _number(value)
    if reset:
        fmt = spec.get("format") or "iso"
        if fmt in {"unix", "unix_ms"}:
            number = _number(value)
            if number is None:
                return None
            return _datetime(number / 1000.0 if fmt == "unix_ms" else number)
        return _datetime(value)
    if isinstance(value, (dict, list)):
        return None
    text = str(value).strip()
    if not text:
        return None
    prefix = str(spec.get("prefix") or "")
    suffix = str(spec.get("suffix") or "")
    text = f"{prefix}{text}{suffix}"
    return text[:500]


def _format_quantity(value: Optional[float]) -> Optional[str]:
    if value is None:
        return None
    if abs(value - round(value)) < 1e-9:
        return f"{int(round(value)):,}"
    if abs(value) >= 100:
        return f"{value:,.0f}"
    return f"{value:,.2f}".rstrip("0").rstrip(".")


def _definition_window_detail(window: dict[str, Any]) -> Optional[str]:
    unit = str(window.get("unit") or "")
    used = window.get("used")
    limit = window.get("limit")
    remaining = window.get("remaining")
    currency = str(window.get("currency") or "")
    if unit == "usd":
        return None  # UsageMeter renders the dollar summary in the headline.
    unit_label = unit if unit and unit != "custom" else "units"
    if limit is not None and limit <= 0:
        return "No allowance reported"
    if used is not None and limit is not None:
        return f"{_format_quantity(used)} of {_format_quantity(limit)} {unit_label}"
    if used is not None:
        return f"{_format_quantity(used)} {unit_label} used"
    if remaining is not None:
        return f"{_format_quantity(remaining)} {unit_label} left"
    return None


def _normalize_definition_window(spec: dict[str, Any], item: Any, index: int) -> Optional[dict[str, Any]]:
    label = _definition_scalar(spec.get("label"), item)
    if not label:
        return None
    used = _definition_scalar((spec.get("numeric") or {}).get("used"), item, numeric=True)
    limit = _definition_scalar((spec.get("numeric") or {}).get("limit"), item, numeric=True)
    remaining = _definition_scalar((spec.get("numeric") or {}).get("remaining"), item, numeric=True)
    used_percent = _definition_scalar((spec.get("numeric") or {}).get("used_percent"), item, numeric=True)
    remaining_percent = _definition_scalar((spec.get("numeric") or {}).get("remaining_percent"), item, numeric=True)
    if all(value is None for value in (used, limit, remaining, used_percent, remaining_percent)):
        return None
    if used_percent is None:
        if limit is not None and limit > 0:
            if used is not None:
                used_percent = (used / limit) * 100.0
            elif remaining is not None:
                used_percent = (1.0 - (remaining / limit)) * 100.0
    if used_percent is None and remaining_percent is not None:
        used_percent = 100.0 - remaining_percent
    if remaining_percent is None and used_percent is not None:
        remaining_percent = 100.0 - used_percent
    if used_percent is not None:
        used_percent = max(0.0, min(100.0, used_percent))
    if remaining_percent is not None:
        remaining_percent = max(0.0, min(100.0, remaining_percent))
    reset_at = _definition_scalar(spec.get("reset_at"), item, reset=True)
    detail = _definition_scalar(spec.get("detail"), item)
    window: dict[str, Any] = {
        "label": label,
        "kind": spec.get("kind") or "custom",
        "rolling": bool(spec.get("rolling", spec.get("kind") == "rolling")),
        "unit": spec.get("unit") or "percent",
        "used_percent": round(used_percent, 2) if used_percent is not None else None,
        "remaining_percent": round(remaining_percent, 2) if remaining_percent is not None else None,
        "reset_at": reset_at,
        "detail": detail or _definition_window_detail({
            "unit": spec.get("unit") or "percent",
            "used": used,
            "limit": limit,
            "remaining": remaining,
            "currency": (spec.get("currency") or {}).get("value") if isinstance(spec.get("currency"), dict) else spec.get("currency"),
        }),
    }
    if spec.get("period_seconds"):
        window["period_seconds"] = spec["period_seconds"]
    currency = spec.get("currency")
    if isinstance(currency, dict):
        currency = _definition_scalar(currency, item)
    if currency:
        window["currency"] = str(currency).upper()
    elif (spec.get("unit") or "") in {"usd", "credits"}:
        # The definition declared money/credits but the dynamic currency path
        # did not resolve. Report that honestly instead of implying USD.
        window["currency"] = "UNKNOWN"
    if used is not None:
        window["used"] = used
    if limit is not None:
        window["limit"] = limit
    if remaining is not None:
        window["remaining"] = remaining
    if (spec.get("unit") or "") == "usd":
        if limit is not None:
            window["allowance_usd"] = limit
        if remaining is not None:
            window["remaining_usd"] = remaining
        if used is not None:
            window["spent_usd"] = used
    return window


def _definition_mapping_windows(mapping: dict[str, Any], payload: Any) -> tuple[list[dict[str, Any]], list[str]]:
    windows: list[dict[str, Any]] = []
    warnings: list[str] = []
    for index, spec in enumerate(mapping.get("windows") or []):
        window = _normalize_definition_window(spec, payload, index)
        if window:
            windows.append(window)
        else:
            label = str((spec or {}).get("label") or f"window {index + 1}")
            warnings.append(f"Window '{label}' had no mapped values and was omitted.")
    source = mapping.get("windows_from")
    if source:
        items = _path_get(payload, source["path"])
        if isinstance(items, list):
            dropped = 0
            for index, item in enumerate(items[:50]):
                window = _normalize_definition_window(source["spec"], item, index)
                if window:
                    windows.append(window)
                else:
                    dropped += 1
            if dropped:
                warnings.append(f"{dropped} of {min(len(items), 50)} mapped windows had no usable values and were omitted.")
            if len(items) > 50:
                warnings.append("Only the first 50 windows are shown.")
        elif items is None:
            warnings.append(f"Mapping path '{source['path']}' was not found, so no windows were read.")
        else:
            warnings.append(f"Mapping path '{source['path']}' is not an array, so no windows were read.")
    return windows, warnings


def _definition_balances(mapping: dict[str, Any], payload: Any) -> tuple[list[dict[str, Any]], list[str]]:
    balances: list[dict[str, Any]] = []
    warnings: list[str] = []
    for spec in mapping.get("balances") or []:
        amount = _definition_scalar(spec.get("amount"), payload, numeric=True)
        if amount is None:
            label = str((spec or {}).get("label") or "balance")
            warnings.append(f"Balance '{label}' had no mapped amount and was omitted.")
            continue
        currency = spec.get("currency")
        if isinstance(currency, dict):
            currency = _definition_scalar(currency, payload)
        resolved_currency = str(currency or "").strip().upper()
        if not resolved_currency:
            # Never guess USD: an unresolved currency is explicitly unknown.
            resolved_currency = "UNKNOWN"
        balances.append({
            "label": spec["label"],
            "amount": amount,
            "currency": resolved_currency,
            "unit": spec.get("unit") or "currency",
            "kind": spec.get("kind") or "credit",
            "detail": _definition_scalar(spec.get("detail"), payload),
        })
    return balances, warnings


def _definition_details(mapping: dict[str, Any], payload: Any) -> list[str]:
    details: list[str] = []
    for spec in mapping.get("details") or []:
        value = _definition_scalar(spec, payload)
        if value:
            details.append(str(value)[:500])
    return details


def _definition_age_seconds(fetched_at: Optional[str]) -> Optional[int]:
    parsed = _datetime(fetched_at)
    if not parsed:
        return None
    try:
        moment = datetime.fromisoformat(parsed.replace("Z", "+00:00"))
        return max(0, int((datetime.now(timezone.utc) - moment).total_seconds()))
    except ValueError:
        return None


def _definition_provenance(
    definition: dict[str, Any],
    *,
    fetched_at: Optional[str],
    cache: str,
    ttl: int,
    profile: Optional[str],
) -> dict[str, Any]:
    return {
        "kind": "declarative",
        "definition_id": definition["id"],
        "definition_version": definition["version"],
        "definition_source": definition.get("_source") or "profile",
        "definition_file": definition.get("_file") or "",
        "docs_url": definition.get("docs_url"),
        "endpoint_host": _definition_endpoint_host(definition),
        "fetched_at": fetched_at,
        "checked_at": _now(),
        "cache": cache,
        "ttl_seconds": ttl,
        "scope": _hermes_home_scope(),
        "scope_kind": "hermes_home",
        "profile": profile or None,
        "overrides": definition.get("_overrides"),
        "approval": definition.get("_approval"),
    }


def _normalize_definition_row(
    definition: dict[str, Any],
    payload: Any,
    *,
    fetched_at: str,
    cache: str,
    profile: Optional[str],
    warnings: Optional[list[str]] = None,
) -> dict[str, Any]:
    mapping = definition["mapping"]
    title = mapping.get("title") or definition["name"]
    plan = _definition_scalar(mapping.get("plan"), payload)
    row = _base(definition["id"], title=title, source="declarative", plan=plan)
    row["label"] = definition["name"]
    row["definition"] = True
    row["definition_id"] = definition["id"]
    row["definition_version"] = definition["version"]
    row["definition_source"] = definition.get("_source") or "profile"
    row["scope"] = _hermes_home_scope()
    row["trust"] = "approved"
    row["state"] = "ok"
    row["provenance"] = _definition_provenance(
        definition, fetched_at=fetched_at, cache=cache, ttl=definition["cache_ttl_seconds"], profile=profile
    )
    windows, mapping_warnings = _definition_mapping_windows(mapping, payload)
    balances, balance_warnings = _definition_balances(mapping, payload)
    details = _definition_details(mapping, payload)
    if definition.get("scope_note"):
        details.append(str(definition["scope_note"]))
    details.extend(mapping_warnings)
    details.extend(balance_warnings)
    details.extend(warnings or [])
    if windows:
        row["limits"] = [{"id": "default", "label": title, "windows": windows}]
        row["capability"] = "usage"
    if balances:
        row["balances"] = balances
        if not windows:
            row["capability"] = "balance"
    row["details"] = details
    row["available"] = bool(windows or balances)
    if not row["available"]:
        row["state"] = "unverified"
        row["unavailable_reason"] = (
            "The endpoint returned JSON, but the definition's mapping produced no windows or balances. "
            "Check its JSON paths and units."
        )
    row["freshness"] = {
        "fetched_at": fetched_at,
        "age_seconds": _definition_age_seconds(fetched_at),
        "stale": False,
        "ttl_seconds": definition["cache_ttl_seconds"],
    }
    return row


def _unavailable_definition_row(
    definition: dict[str, Any],
    *,
    state: str,
    reason: str,
    profile: Optional[str],
    trust: Optional[str] = None,
    approval: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    row = _base(definition["id"], title=definition["name"], source="declarative", plan=None)
    row["label"] = definition["name"]
    row["definition"] = True
    row["definition_id"] = definition["id"]
    row["definition_version"] = definition["version"]
    row["definition_source"] = definition.get("_source") or "profile"
    row["scope"] = _hermes_home_scope()
    row["state"] = state
    row["available"] = False
    row["capability"] = "usage" if definition["mapping"].get("windows") or definition["mapping"].get("windows_from") else "balance"
    row["unavailable_reason"] = reason
    if trust:
        row["trust"] = trust
    if approval:
        row["approval"] = approval
    row["provenance"] = _definition_provenance(
        definition, fetched_at=None, cache="none", ttl=definition["cache_ttl_seconds"], profile=profile
    )
    row["provenance"]["error"] = reason
    row["freshness"] = {
        "fetched_at": None,
        "age_seconds": None,
        "stale": False,
        "ttl_seconds": definition["cache_ttl_seconds"],
    }
    return row


def _definition_cache_key(definition: dict[str, Any], profile: Optional[str], headers: dict[str, str]) -> str:
    credential_shape = hashlib.sha256(
        json.dumps(headers, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    # Scope the cache to the effective canonical home, never to the display
    # word "active": a named profile can share a name across homes, and the
    # default profile is still a concrete home.
    return (
        f"{_hermes_home_scope()}|{profile or ''}|{definition['id']}|"
        f"{definition.get('_digest') or ''}|{credential_shape}"
    )


def _fetch_declarative(
    definition: dict[str, Any],
    *,
    profile: Optional[str],
    headers: dict[str, str],
    transport: Any = None,
) -> dict[str, Any]:
    payload = _definition_request_json(definition, headers, transport=transport)
    return _normalize_definition_row(
        definition,
        payload,
        fetched_at=_now(),
        cache="miss",
        profile=profile,
    )


def _fetch_declarative_cached(
    definition: dict[str, Any],
    *,
    profile: Optional[str],
    headers: Optional[dict[str, str]] = None,
    transport: Any = None,
) -> dict[str, Any]:
    trust, trust_reason = _definition_trust(definition)
    if trust != "approved":
        return _unavailable_definition_row(
            definition,
            state="requires_approval" if trust == "untrusted" else "blocked",
            reason=trust_reason,
            profile=profile,
            trust=trust,
            approval=_definition_approval_view(definition, trust, trust_reason),
        )
    if headers is None:
        headers, missing = _resolve_definition_headers(definition)
        if missing:
            return _unavailable_definition_row(
                definition,
                state="not_connected",
                reason=(
                    "Not connected: provide "
                    + ", ".join(missing)
                    + " through the profile's Hermes secret scope, then refresh. Credentials never appear in this pane."
                ),
                profile=profile,
                trust=trust,
                approval=_definition_approval_view(definition, trust),
            )
    key = _definition_cache_key(definition, profile, headers)
    ttl = int(definition.get("cache_ttl_seconds") or 300)
    now_mono = time.monotonic()
    with _DEFINITION_CACHE_LOCK:
        entry = _DEFINITION_CACHE.get(key)
    if entry and now_mono - float(entry.get("at") or 0) < ttl:
        row = copy.deepcopy(entry["row"])
        row["provenance"]["cache"] = "hit"
        row["provenance"]["checked_at"] = _now()
        fetched_at = row.get("fetched_at") or row.get("freshness", {}).get("fetched_at")
        row["freshness"] = {
            "fetched_at": fetched_at,
            "age_seconds": _definition_age_seconds(fetched_at),
            "stale": False,
            "ttl_seconds": ttl,
        }
        return row
    try:
        row = _fetch_declarative(definition, profile=profile, headers=headers, transport=transport)
    except _DefinitionError as exc:
        # A security block is never softened into "stale": an approval can be
        # revoked or a destination can start resolving privately between runs.
        if entry and exc.state not in {"blocked", "requires_approval"}:
            row = copy.deepcopy(entry["row"])
            row["state"] = "stale"
            row["provenance"]["cache"] = "stale"
            row["provenance"]["checked_at"] = _now()
            row["provenance"]["error"] = exc.message
            fetched_at = row.get("fetched_at") or row.get("freshness", {}).get("fetched_at")
            row["freshness"] = {
                "fetched_at": fetched_at,
                "age_seconds": _definition_age_seconds(fetched_at),
                "stale": True,
                "ttl_seconds": ttl,
            }
            return row
        return _unavailable_definition_row(
            definition,
            state=exc.state,
            reason=exc.message,
            profile=profile,
            trust="approved",
            approval=_definition_approval_view(definition, "approved"),
        )
    with _DEFINITION_CACHE_LOCK:
        _DEFINITION_CACHE[key] = {"at": now_mono, "row": copy.deepcopy(row)}
        if len(_DEFINITION_CACHE) > 128:
            oldest = sorted(_DEFINITION_CACHE.items(), key=lambda item: float(item[1].get("at") or 0))[: len(_DEFINITION_CACHE) - 128]
            for stale_key, _ in oldest:
                _DEFINITION_CACHE.pop(stale_key, None)
    return row


def _definition_catalog_entry(
    entry: dict[str, Any],
    *,
    row: Optional[dict[str, Any]],
    prepared_item: Optional[dict[str, Any]],
    profile: Optional[str],
) -> dict[str, Any]:
    definition = entry.get("definition")
    prepared_item = prepared_item or {}
    if not definition:
        return {
            "id": entry.get("id") or "unknown",
            "name": entry.get("name") or entry.get("id") or "Invalid definition",
            "source": entry.get("source") or "profile",
            "file": entry.get("file") or "",
            "state": "invalid",
            "trust": "blocked",
            "approval_required": False,
            "errors": list(entry.get("errors") or [])[:8],
            "warnings": list(entry.get("warnings") or [])[:8],
        }
    missing = list(prepared_item.get("missing") or [])
    trust = str(prepared_item.get("trust") or ("approved" if definition.get("_source") == "bundled" else "untrusted"))
    reason = str(prepared_item.get("reason") or "")
    if trust == "untrusted":
        state = "requires_approval"
    elif trust == "blocked":
        state = "blocked"
    elif row:
        state = str(row.get("state") or "connected")
        if state == "ok":
            state = "connected"
    else:
        state = "available" if missing else "ready"
    approval = _definition_approval_view(definition, trust, reason)
    refs = _definition_credential_refs(definition)
    return {
        "id": definition["id"],
        "name": definition["name"],
        "description": definition.get("description"),
        "version": definition["version"],
        "source": definition.get("_source") or "profile",
        "file": definition.get("_file") or "",
        "host": _definition_endpoint_host(definition),
        "docs_url": definition.get("docs_url"),
        "stability": definition.get("stability") or "experimental",
        "scope_note": definition.get("scope_note") or definition["mapping"].get("scope_note"),
        "state": state,
        "trust": trust,
        "approval_required": trust != "approved",
        "approval": approval,
        "credential_refs": refs,
        "credential_labels": _definition_credential_labels(definition),
        "missing_credentials": missing,
        "setup": {
            "file": f"{definition['id']}.json",
            "env": missing,
            "directory": "$HERMES_HOME/provider-usage/providers",
            "validate": "POST /api/plugins/jg-provider-usage/definitions/validate",
            "approve": "python scripts/approve_definition.py <definition.json>",
        },
        "overrides": entry.get("overrides"),
        "errors": list(entry.get("errors") or [])[:8],
        "warnings": list(entry.get("warnings") or [])[:8],
        "last_error": reason or (row or {}).get("unavailable_reason"),
        "scope": _hermes_home_scope(),
        "profile": profile or "default",
    }


def _definition_catalog(
    loaded: dict[str, Any],
    *,
    rows: dict[str, dict[str, Any]],
    prepared: dict[str, dict[str, Any]],
    profile: Optional[str],
) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    for ident, entry in loaded["valid"].items():
        prepared_item = prepared.get(ident) or {}
        entries.append(
            _definition_catalog_entry(
                entry,
                row=rows.get(ident),
                prepared_item=prepared_item,
                profile=profile,
            )
        )
    for entry in loaded["invalid"]:
        entries.append(_definition_catalog_entry(entry, row=None, prepared_item=None, profile=profile))
    order = {
        "connected": 0,
        "available": 1,
        "unverified": 2,
        "stale": 2,
        "requires_approval": 3,
        "needs_permission": 4,
        "blocked": 5,
        "unavailable": 6,
        "invalid": 7,
    }
    entries.sort(key=lambda item: (order.get(str(item.get("state")), 9), str(item.get("name") or "").lower()))
    counts: dict[str, int] = {}
    for item in entries:
        state = str(item.get("state") or "available")
        counts[state] = counts.get(state, 0) + 1
    return {
        "version": 1,
        "profile": profile or "default",
        "scope": _hermes_home_scope(),
        "scope_kind": "hermes_home",
        "directory": "$HERMES_HOME/provider-usage/providers",
        "approvals_file": "approvals.json (outside the definitions directory)",
        "definitions": entries,
        "counts": counts,
        "bundled_count": loaded.get("bundled_count", 0),
        "profile_count": loaded.get("profile_count", 0),
    }


def _definition_inventory(
    loaded: dict[str, Any],
    *,
    prepared: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    rows = []
    for ident in prepared:
        definition = loaded["valid"][ident]["definition"]
        rows.append({
            "id": ident,
            "label": definition["name"],
            "configured": True,
            "supported": True,
            "definition": True,
            "capability": "usage" if definition["mapping"].get("windows") or definition["mapping"].get("windows_from") else "balance",
        })
    return rows


def _prepare_definitions(loaded: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Resolve readiness without touching credentials for untrusted definitions.

    Bundled definitions are code-owned. Profile-local definitions must match the
    approval manifest before their header references are resolved; an untrusted
    or blocked definition exposes only its destination and reference names.
    """
    approvals, approval_error = _load_definition_approvals()
    prepared: dict[str, dict[str, Any]] = {}
    for ident, entry in loaded["valid"].items():
        definition = entry["definition"]
        trust, reason = _definition_trust(definition, approvals=approvals, approval_error=approval_error)
        definition["_approval"] = _definition_approval_preview(definition)
        item: dict[str, Any] = {
            "definition": definition,
            "trust": trust,
            "reason": reason,
            "headers": {},
            "missing": [],
        }
        if trust == "approved":
            headers, missing = _resolve_definition_headers(definition)
            item["headers"] = headers
            item["missing"] = missing
        prepared[ident] = item
    return prepared


@router.get("/definitions/catalog")
def definitions_catalog(profile: Optional[str] = None) -> dict[str, Any]:
    cleaned = _clean_profile(profile)
    from hermes_cli.web_server_profiles import _config_profile_scope

    with _config_profile_scope(cleaned):
        loaded = _load_provider_definitions()
        prepared = _prepare_definitions(loaded)
        return _definition_catalog(loaded, rows={}, prepared=prepared, profile=cleaned)


@router.post("/definitions/validate")
def definitions_validate(payload: Optional[dict[str, Any]] = Body(default=None)) -> dict[str, Any]:
    body = payload if isinstance(payload, dict) else {}
    raw = body.get("definition")
    if raw is None and isinstance(body.get("json"), str):
        try:
            raw = json.loads(body["json"])
        except json.JSONDecodeError as exc:
            return {"ok": False, "errors": [f"json: {exc.msg} at line {exc.lineno}"], "warnings": [], "summary": None}
        except RecursionError:
            return {
                "ok": False,
                "errors": ["json: nesting is too deep to validate safely"],
                "warnings": [],
                "summary": None,
            }
    definition, errors, warnings = _validate_definition(raw, source="profile", allow_override=True)
    summary = None
    if definition:
        summary = {
            "id": definition["id"],
            "name": definition["name"],
            "version": definition["version"],
            "host": _definition_endpoint_host(definition),
            "cache_ttl_seconds": definition["cache_ttl_seconds"],
            "windows": len(definition["mapping"]["windows"]) + (1 if definition["mapping"]["windows_from"] else 0),
            "balances": len(definition["mapping"]["balances"]),
            "details": len(definition["mapping"]["details"]),
            "credential_refs": _definition_credential_refs(definition),
            "credential_labels": _definition_credential_labels(definition),
            "requires_approval": definition.get("_source") != "bundled",
        }
    return {"ok": bool(definition), "errors": errors, "warnings": warnings, "summary": summary}


def _fetch_anthropic() -> dict[str, Any]:
    # Read-only: core's read-only variant never refreshes the Claude Code grant
    # just to read its usage windows.
    snapshot = _core_usage("anthropic")
    if snapshot is None:
        return _provider_unavailable("anthropic")
    return _serialize_snapshot(snapshot)


# --- Novita balance (documented, works with the inference key) ---------------------------
_NOVITA_BALANCE_URL = "https://api.novita.ai/openapi/v1/billing/balance/detail"
_NOVITA_UNITS_PER_USD = 10000


def _novita_row(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalize Novita's balance body: integer strings in 1/10000 USD."""
    row = _base("novita", title="Novita balance", source="billing_balance_api")
    for key, label, kind in (("availableBalance", "Available balance", "credit"),
                             ("cashBalance", "Cash balance", "wallet"),
                             ("pendingCharges", "Pending charges", "spend"),
                             ("creditLimit", "Credit limit", "limit")):
        amount = _number(payload.get(key))
        if amount is None:
            continue
        row["balances"].append({"label": label, "amount": round(amount / _NOVITA_UNITS_PER_USD, 4),
                                "currency": "USD", "kind": kind})
    row["available"] = bool(row["balances"])
    if row["available"]:
        row["details"].append("Amounts are reported by Novita in units of 1/10000 USD.")
    else:
        row["unavailable_reason"] = "Novita returned no balance fields."
    return row


def _fetch_novita() -> dict[str, Any]:
    token = _read_definition_secret("NOVITA_API_KEY")
    if not token:
        return _provider_unavailable("novita")
    try:
        response = _fixed_provider_get(_NOVITA_BALANCE_URL, token, host="api.novita.ai", timeout=12.0)
        payload = response.json() or {}
        if not isinstance(payload, dict):
            return _provider_unavailable("novita")
        return _mark_env_read(_novita_row(payload), "NOVITA_API_KEY")
    except Exception:
        log.debug("Novita balance read failed", exc_info=True)
        return _provider_unavailable("novita")


def _fetch_provider_raw(provider: str, *, definition: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    if definition is not None:
        return _fetch_declarative_cached(definition, profile=None)
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
        return _fetch_anthropic()
    if provider == "novita":
        return _fetch_novita()
    return _unavailable(provider, "No usage or balance endpoint is known for this provider.")


# Every card uses the same window vocabulary and order, whichever words the provider uses.
_WINDOW_KIND_ORDER = ("five_hour", "daily", "weekly", "monthly", "rolling", "custom")


def _window_kind_from_label(label: Any) -> str:
    text = str(label or "").lower()
    if "5" in text and ("hour" in text or "hr" in text or "session" in text):
        return "five_hour"
    if "day" in text or "daily" in text or "24h" in text:
        return "daily"
    if "week" in text:
        return "weekly"
    if "month" in text:
        return "monthly"
    if "rolling" in text:
        return "rolling"
    return ""


def _normalize_card(row: dict[str, Any]) -> dict[str, Any]:
    """Give every window a kind when its label states one; keep the provider's own order.

    Order is not normalised on purpose: a provider may list model-scoped windows in a
    meaningful sequence, and the renderer already picks the governing window per model.
    """
    for limit in row.get("limits") or ():
        windows = limit.get("windows") if isinstance(limit, dict) else None
        if not isinstance(windows, list):
            continue
        for window in windows:
            if isinstance(window, dict) and not window.get("kind"):
                kind = _window_kind_from_label(window.get("label"))
                if kind:
                    window["kind"] = kind
    return row


def _fetch_provider(provider: str, *, definition: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    return _normalize_card(_fetch_provider_raw(provider, definition=definition))


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
    """Presence only from core metadata or the profile secret scope, never a store."""
    return _local_presence(provider)[0]


# ---------------------------------------------------------------------------
# Per-account usage (overview `accounts[]`)
#
# The running-agents footer may attach a provider's shared pool to a child only
# when the row names exactly one account identity equal to the child's. Core's
# pooled-credential namespace is the only trusted source for that id; the plugin
# never reads the pool itself. Metadata is cheap, so it is listed each overview;
# per-account usage is a network read, so it is TTL-cached, deduped by identity
# and bounded per provider. A missing identity stops there - it is never retried
# as a provider-wide read, which could borrow another login's pool.
# ---------------------------------------------------------------------------

_ACCOUNT_USAGE_TTL_SECS = 60.0
_ACCOUNT_USAGE_MAX_ENTRIES = 32
_ACCOUNT_USAGE_MAX_ACCOUNTS = 8
_ACCOUNT_USAGE_ENRICH_LIMIT = 4
_ACCOUNT_METADATA_KEYS = (
    "credential_id", "account_id", "label", "auth_type", "source", "available",
    "status", "request_count", "last_status_at",
)
_ACCOUNT_ROW_KEYS = (
    "id", "capability", "plan", "source", "fetched_at", "available", "limits",
    "balances", "details", "key_usage", "activity", "credit_status",
    "reset_credits", "products", "spend_control", "model_access",
)
# Providers with a real core read-only fetcher. xAI is brokered by this plugin
# and Nous credits are account-global, so neither gets a per-identity fetch.
_ACCOUNT_USAGE_PROVIDERS = frozenset({
    "openai-codex", "anthropic", "openrouter", "deepseek", "ollama-cloud",
    "opencode-zen", "opencode-go",
})
_ACCOUNT_GLOBAL_PROVIDERS = frozenset({"nous"})
_ACCOUNT_USAGE_CACHE: dict[tuple[str, str, str], tuple[float, Optional[dict[str, Any]]]] = {}
_ACCOUNT_USAGE_LOCKS: dict[tuple[str, str, str], threading.Lock] = {}
_ACCOUNT_USAGE_LOCK = threading.Lock()


def _account_identities(provider: str) -> list[dict[str, Any]]:
    """Non-secret pooled accounts for *provider*, deduped by core identity id.

    Stock 0.23.1 has no identity inventory; the row then carries no ``accounts``
    metadata and the footer shows the account as unknown instead of guessing.
    """
    list_identities = _core_helper("list_account_usage_identities")
    if list_identities is None:
        return []
    try:
        rows = list_identities(provider) or []
    except Exception:
        log.debug("provider-usage account identities unavailable for %s", provider, exc_info=True)
        return []
    accounts: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in rows:
        if not isinstance(entry, dict):
            continue
        identity_id = str(entry.get("identity_id") or "").strip()
        if not identity_id or identity_id in seen:
            continue
        seen.add(identity_id)
        account = {
            key: copy.deepcopy(entry[key])
            for key in _ACCOUNT_METADATA_KEYS
            if entry.get(key) is not None
        }
        account["identity_id"] = identity_id
        account["label"] = str(entry.get("label") or identity_id)
        accounts.append(account)
        if len(accounts) >= _ACCOUNT_USAGE_MAX_ACCOUNTS:
            break
    return accounts


def _clear_account_caches() -> None:
    """Test seam: drop cached per-account snapshots and their per-key locks."""
    with _ACCOUNT_USAGE_LOCK:
        _ACCOUNT_USAGE_CACHE.clear()
        _ACCOUNT_USAGE_LOCKS.clear()


def _account_usage_row(provider: str, identity_id: str) -> Optional[dict[str, Any]]:
    """One exact account's normalized usage, or ``None`` (never a fallback read)."""
    wanted = str(identity_id or "").strip()
    if not wanted:
        return None
    key = (provider, wanted, _hermes_home_scope())
    now = time.monotonic()
    with _ACCOUNT_USAGE_LOCK:
        cached = _ACCOUNT_USAGE_CACHE.get(key)
        if cached is not None and now - cached[0] < _ACCOUNT_USAGE_TTL_SECS:
            return copy.deepcopy(cached[1])
        lock = _ACCOUNT_USAGE_LOCKS.setdefault(key, threading.Lock())
    with lock:
        with _ACCOUNT_USAGE_LOCK:
            cached = _ACCOUNT_USAGE_CACHE.get(key)
            if cached is not None and now - cached[0] < _ACCOUNT_USAGE_TTL_SECS:
                return copy.deepcopy(cached[1])
        snapshot = _core_usage(provider, identity_id=wanted)
        if snapshot is None:
            # A missing per-identity snapshot is a negative cache entry; it is
            # never retried as a provider-wide read.
            with _ACCOUNT_USAGE_LOCK:
                _ACCOUNT_USAGE_CACHE[key] = (time.monotonic(), None)
                if len(_ACCOUNT_USAGE_CACHE) > _ACCOUNT_USAGE_MAX_ENTRIES:
                    oldest = min(_ACCOUNT_USAGE_CACHE, key=lambda item: _ACCOUNT_USAGE_CACHE[item][0])
                    _ACCOUNT_USAGE_CACHE.pop(oldest, None)
            return None
        row = _serialize_snapshot(snapshot)
        verified = _verified_row_identity(row)
        if not verified or verified != wanted:
            # A missing or different identity cannot be attributed to the
            # requested account. Return unknown rather than borrowing a
            # provider-wide or another login's figures.
            log.debug("provider-usage account read for %s did not prove identity %s", provider, wanted)
            return None
        with _ACCOUNT_USAGE_LOCK:
            _ACCOUNT_USAGE_CACHE[key] = (time.monotonic(), row)
            if len(_ACCOUNT_USAGE_CACHE) > _ACCOUNT_USAGE_MAX_ENTRIES:
                oldest = min(_ACCOUNT_USAGE_CACHE, key=lambda item: _ACCOUNT_USAGE_CACHE[item][0])
                _ACCOUNT_USAGE_CACHE.pop(oldest, None)
        return copy.deepcopy(row)


def _account_row_fields(row: dict[str, Any]) -> dict[str, Any]:
    """Normalized usage fields an account entry carries (footer/pane consumers)."""
    return {
        key: copy.deepcopy(row[key])
        for key in _ACCOUNT_ROW_KEYS
        if key in row and row[key] is not None
    }


def _verified_row_identity(row: dict[str, Any]) -> str:
    """The account id a usage snapshot proved it was fetched for, else ``""``.

    Core stamps ``identity_id``/``account_id`` from the snapshot it fetched; a
    stock snapshot's decoded ``identity`` is mapped onto ``identity_id``. A
    provider-wide snapshot with no decoded identity stays unset rather than
    guessing.
    """
    for key in ("identity_id", "account_id"):
        value = str(row.get(key) or "").strip()
        if value:
            return value
    return ""


def _attach_accounts(provider: str, row: dict[str, Any]) -> dict[str, Any]:
    """Attach known account identities, and per-account usage where provable.

    A provider-wide row is reused for a single pool account only when its
    snapshot proved that exact identity. An unverified (env/singleton) fetch is
    not evidence of the sole pool account: supported providers get an exact
    per-identity read instead, and providers without one (xAI, Nous credits)
    stay unknown. With two or more logins a provider-wide figure is ambiguous:
    entries carry only their own identity-scoped snapshot, and the flat row
    keeps only the identity its own snapshot proved (if any), never a guessed
    account.
    """
    accounts = _account_identities(provider)
    if not accounts:
        return row
    single = len(accounts) == 1
    source_identity = _verified_row_identity(row)
    exact_fetch_supported = (
        provider in _ACCOUNT_USAGE_PROVIDERS
        and provider not in _ACCOUNT_GLOBAL_PROVIDERS
    )
    entries: list[dict[str, Any]] = []
    for index, account in enumerate(accounts):
        entry = dict(account)
        identity_id = str(account.get("identity_id") or "").strip()
        if single:
            if identity_id and source_identity and source_identity == identity_id:
                # The provider-wide snapshot was fetched with this exact credential,
                # so its figures are this account's; reuse them without another read.
                entry.update(_account_row_fields(row))
                row["identity_id"] = identity_id
                row["account_label"] = str(account.get("label") or identity_id)
            elif identity_id and exact_fetch_supported:
                # Never stamp the provider-wide row with a pool account the fetch did
                # not prove. Read the account's own snapshot instead of copying.
                try:
                    usage = _account_usage_row(provider, identity_id)
                except Exception:
                    log.debug("provider-usage account read failed for %s", provider, exc_info=True)
                    usage = None
                usage_identity = _verified_row_identity(usage) if usage else ""
                if usage and usage_identity == identity_id:
                    entry.update(_account_row_fields(usage))
            # No exact fetch (xAI is brokered provider-wide; Nous credits are
            # account-global): the entry stays unknown rather than borrowing a
            # figure from an unproven credential.
        elif (
            provider in _ACCOUNT_USAGE_PROVIDERS
            and provider not in _ACCOUNT_GLOBAL_PROVIDERS
            and index < _ACCOUNT_USAGE_ENRICH_LIMIT
        ):
            try:
                usage = _account_usage_row(provider, str(account["identity_id"]))
            except Exception:
                log.debug("provider-usage account read failed for %s", provider, exc_info=True)
                usage = None
            usage_identity = _verified_row_identity(usage) if usage else ""
            if usage and usage_identity == str(account["identity_id"]):
                entry.update(_account_row_fields(usage))
        entries.append(entry)
    row["accounts"] = entries
    return row


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
    return {"ok": True, "plugin": "jg-provider-usage", "version": _PLUGIN_VERSION}


@router.get("/diagnostics")
def diagnostics(provider: str = "") -> dict[str, Any]:
    """What the last refresh actually did.

    Read-only and credential-free: row ids, per-provider timings and failure reasons,
    plus whether this profile's keys resolve through the host's secret scope. A chip
    that reads "Usage unavailable" with no reason is undiagnosable from the UI, and
    the host log only shows what the backend writes — so the backend writes this.
    """
    credentials: dict[str, Any] = {}
    try:
        from agent.secret_scope import get_secret
    except Exception as exc:  # a host without the secret API: say so, never fall back to os.environ
        credentials["secret_scope"] = f"unavailable ({type(exc).__name__})"
    else:
        for name in ("DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_API_KEY"):
            try:
                value = get_secret(name)
            except Exception as exc:
                credentials[name] = f"raised {type(exc).__name__}"
            else:
                credentials[name] = "present" if isinstance(value, str) and value else "missing"
    return {
        "ok": True,
        "plugin": "jg-provider-usage",
        "version": _PLUGIN_VERSION,
        "deadline_s": _OVERVIEW_DEADLINE_S,
        "last_overview": copy.deepcopy(_LAST_OVERVIEW) or None,
        "credentials": credentials,
        "core_broker": _core_broker_capability(),
        "report_url": _report_url(provider),
    }


def _core_broker_capability() -> dict[str, Any]:
    """What the running Hermes build can do for this plugin, in one credential-free line.

    Older builds expose ``credentialed_provider_request`` with a Codex-only table, so a Grok
    card that says "limited data" is an upgrade problem, not a bug and not a reason to read
    the OAuth token. Report the shape, never the provider's secret.
    """
    try:
        from hermes_cli.plugin_provider_requests import credentialed_providers
    except ImportError:
        return {"available": False, "providers": 0, "xai": False, "reason": "helper missing"}
    try:
        names = tuple(credentialed_providers())
    except Exception as exc:  # a core bug must not take down diagnostics
        return {"available": False, "providers": 0, "xai": False, "reason": type(exc).__name__}
    return {"available": True, "providers": len(names), "xai": "xai-oauth" in names,
            "reason": "" if "xai-oauth" in names else "core broker has no xai-oauth route"}


#: Prefilled issue form. Field names match .github/ISSUE_TEMPLATE/provider-data.yml, so the
#: reporter lands on the form with the provider and versions already filled in.
_REPORT_REPO = "jerrygooch/hermes-provider-usage"


def _report_url(provider: str = "") -> str:
    from urllib.parse import urlencode

    params = {"template": "provider-data.yml", "labels": "provider-data",
              "versions": f"plugin {_PLUGIN_VERSION}"}
    provider = str(provider or "").strip()
    if provider:
        params["provider"] = provider
    return f"https://github.com/{_REPORT_REPO}/issues/new?{urlencode(params)}"


# --- Settings ---------------------------------------------------------------------------
# One file per profile, data-only, no secrets. The spec is the allowlist: an unknown key is
# rejected rather than stored, so a future setting needs a deliberate entry here.
_SETTINGS_FILE = "settings.json"
_SETTINGS_SPEC: dict[str, dict[str, Any]] = {
    "compat_oauth_reads": {
        "type": "bool",
        "default": False,
        "label": "Compatibility mode for OAuth providers",
        "help": ("Read subscription usage through Hermes's own locked sign-in path when this "
                 "build has no provider broker. The access token stays in this process for one "
                 "request and is never stored by the plugin."),
    },
}


def _settings_path() -> Path:
    return _hermes_home() / "provider-usage" / _SETTINGS_FILE


def _read_settings() -> dict[str, Any]:
    """Stored values coerced to their declared type; anything unrecognised falls back."""
    try:
        raw = json.loads(_settings_path().read_text("utf-8"))
    except (OSError, ValueError):
        raw = {}
    raw = raw if isinstance(raw, dict) else {}
    values: dict[str, Any] = {}
    for key, spec in _SETTINGS_SPEC.items():
        value = raw.get(key, spec["default"])
        values[key] = value if isinstance(value, bool) else bool(spec["default"])
    return values


def _write_settings(values: dict[str, Any]) -> None:
    """Atomic replace, so a crash cannot leave a half-written settings file."""
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_suffix(".json.tmp")
    staged.write_text(json.dumps(values, indent=2, sort_keys=True) + "\n", "utf-8")
    os.replace(staged, path)


def _settings_spec_for_ui() -> list[dict[str, Any]]:
    return [{"key": key, "type": spec["type"], "default": spec["default"],
             "label": spec["label"], "help": spec["help"]} for key, spec in _SETTINGS_SPEC.items()]


@router.get("/settings")
def get_settings() -> dict[str, Any]:
    """The profile's plugin preferences, with the spec the UI renders from."""
    return {"ok": True, "settings": _read_settings(), "spec": _settings_spec_for_ui(),
            "path": "$HERMES_HOME/provider-usage/settings.json"}


@router.put("/settings")
def put_settings(payload: Optional[dict[str, Any]] = Body(default=None)) -> dict[str, Any]:
    """Validate against the spec, then store. Unknown keys and wrong types are refused."""
    body = payload if isinstance(payload, dict) else {}
    updates = body.get("settings") if isinstance(body.get("settings"), dict) else body
    errors = [f"unknown setting: {key}" for key in sorted(set(updates) - set(_SETTINGS_SPEC))]
    values = _read_settings()
    for key, spec in _SETTINGS_SPEC.items():
        if key not in updates:
            continue
        value = updates[key]
        if spec["type"] == "bool" and not isinstance(value, bool):
            errors.append(f"{key} must be true or false")
            continue
        values[key] = value
    if errors:
        return {"ok": False, "errors": errors, "settings": _read_settings()}
    _write_settings(values)
    return {"ok": True, "errors": [], "settings": values, "path": "$HERMES_HOME/provider-usage/settings.json"}


def _clean_profile(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text or text.lower() in {"current", "active"}:
        return None
    return text


def _clean_reset_identity(value: Any) -> Optional[str]:
    """Exact non-secret active-account id read from the stock snapshot."""
    text = str(value or "").strip()
    return text if text and len(text) <= 256 else None


_RESET_SERVICE_MODULE: Optional[Any] = None
_RESET_SERVICE_MODULE_LOCK = threading.Lock()
# Preview and confirm are separate HTTP requests, so the short-lived
# single-use confirmation store must outlive one ResetService construction.
# One store per (profile, account, dashboard session) keeps tokens isolated
# without sharing them across identities or sessions.
_RESET_STORES: dict[tuple[str, str, str], Any] = {}
_RESET_STORES_LOCK = threading.Lock()
_MAX_RESET_STORES = 256
_RESET_SERVICE_UNAVAILABLE = (
    "Reset support is unavailable because this installed build is missing its reset service. "
    "Nothing was spent."
)


def _reset_service_path() -> Path:
    """Sibling module path; a small seam so a missing install is testable."""
    return Path(__file__).with_name("reset_service.py")


def _reset_service_module() -> Any:
    """Load the sibling reset service by path, gracefully or return ``None``.

    ``plugin_api.py`` is executed by a path spec without the ``dashboard``
    directory on ``sys.path``; a plain ``import reset_service`` would fail in
    the real host.  Caching one module keeps the short-lived confirmation store
    shared across requests in this backend process.  An installed build that
    omitted the optional reset module degrades to an honest unavailable
    response instead of a 500 on every reset route.
    """
    global _RESET_SERVICE_MODULE
    if _RESET_SERVICE_MODULE is not None:
        return _RESET_SERVICE_MODULE
    with _RESET_SERVICE_MODULE_LOCK:
        if _RESET_SERVICE_MODULE is None:
            path = _reset_service_path()
            module_name = "hermes_dashboard_jg_provider_usage_reset_service"
            try:
                if not path.is_file():
                    log.debug("provider-usage reset service is not installed at %s", path)
                    return None
                spec = importlib.util.spec_from_file_location(module_name, path)
                if spec is None or spec.loader is None:
                    log.debug("provider-usage reset service has no importable spec")
                    return None
                module = importlib.util.module_from_spec(spec)
                sys.modules[module_name] = module
                spec.loader.exec_module(module)
            except Exception:
                sys.modules.pop(module_name, None)
                log.debug("provider-usage reset service could not be loaded", exc_info=True)
                return None
            _RESET_SERVICE_MODULE = module
    return _RESET_SERVICE_MODULE


class _UnavailableResetService:
    """Honest no-op used when the optional reset module is not installed."""

    def _payload(self) -> dict[str, Any]:
        return {
            "ok": False, "state": "unavailable", "status": "unavailable",
            "reason": "reset_service_unavailable", "message": _RESET_SERVICE_UNAVAILABLE,
            "action_label": "Redeem one banked Codex reset (server-selected)",
            "credit_consumed": "no", "credit_kind": "banked_reset", "purchased_credit_used": False,
            "needs_reconcile": False, "readback_mismatch": False,
            "summary": None, "confirmation": None, "readback": None,
        }

    def summary(self) -> dict[str, Any]:
        return self._payload()

    def preview(self) -> dict[str, Any]:
        return self._payload()

    def confirm(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return self._payload()

    def readback(self) -> dict[str, Any]:
        return self._payload()


def _reset_session_id(request: Request, profile: Optional[str]) -> Optional[str]:
    """Opaque server-derived session binding, never a body field or raw header.

    Prefer a verified session on ``request.state``; otherwise use the dashboard
    session-token header, or the stable local client tuple for stock Desktop.
    Only a SHA-256 digest reaches the reset service/store.
    """
    values: list[str] = []
    session = getattr(getattr(request, "state", None), "session", None)
    if session is not None:
        for key in ("sid", "session_id", "id", "sub", "email"):
            value = session.get(key) if isinstance(session, dict) else getattr(session, key, None)
            if value:
                values.append(str(value))
                break
    headers = getattr(request, "headers", None)
    if headers is not None:
        token = headers.get("x-hermes-session-token")
        if token:
            values.append(str(token))
        if not values:
            client = getattr(request, "client", None)
            host = str(getattr(client, "host", "") or "")
            user_agent = str(headers.get("user-agent") or "")[:256]
            if host or user_agent:
                values.append(f"local-session:{_clean_profile(profile) or 'current'}:{host}:{user_agent}")
    for value in values:
        text = value.strip()
        if text:
            return hashlib.sha256(text.encode("utf-8")).hexdigest()
    return None


def _reset_confirmation_store(module: Any, profile: Optional[str], identity_id: Optional[str],
                              session_id: Optional[str]) -> Any:
    """Return the process-wide short-lived store for this exact reset scope."""
    key = (_clean_profile(profile) or "default", identity_id or "", session_id or "")
    with _RESET_STORES_LOCK:
        store = _RESET_STORES.get(key)
        if store is None:
            if len(_RESET_STORES) >= _MAX_RESET_STORES:
                _RESET_STORES.pop(next(iter(_RESET_STORES)))
            store = module.ResetConfirmationStore()
            _RESET_STORES[key] = store
        return store


def _reset_service_for(
    request: Request,
    profile: Optional[str],
    identity_id: Optional[str],
    *,
    require_session: bool,
) -> Any:
    module = _reset_service_module()
    if module is None:
        return _UnavailableResetService()
    try:
        session_id = _reset_session_id(request, profile) if require_session else None
        store = _reset_confirmation_store(module, profile, identity_id, session_id) if require_session else None
        return module.ResetService(
            profile=profile,
            identity_id=identity_id,
            session_id=session_id,
            store=store,
        )
    except Exception:
        log.debug("provider-usage reset service could not be constructed", exc_info=True)
        return _UnavailableResetService()


@router.post("/reset/summary")
def reset_summary(request: Request, payload: Optional[dict[str, Any]] = Body(default=None)) -> dict[str, Any]:
    """Read-only banked-reset inventory for one exact account."""
    body = payload if isinstance(payload, dict) else {}
    return _reset_service_for(
        request,
        _clean_profile(body.get("profile")),
        _clean_reset_identity(body.get("identity_id")),
        require_session=False,
    ).summary()


@router.post("/reset/preview")
def reset_preview(request: Request, payload: Optional[dict[str, Any]] = Body(default=None)) -> dict[str, Any]:
    """Verify the active account and issue a short-lived confirmation token."""
    body = payload if isinstance(payload, dict) else {}
    return _reset_service_for(
        request,
        _clean_profile(body.get("profile")),
        _clean_reset_identity(body.get("identity_id")),
        require_session=True,
    ).preview()


@router.post("/reset/confirm")
def reset_confirm(request: Request, payload: Optional[dict[str, Any]] = Body(default=None)) -> dict[str, Any]:
    """Consume one preview and redeem at most one banked reset."""
    body = payload if isinstance(payload, dict) else {}
    return _reset_service_for(
        request,
        _clean_profile(body.get("profile")),
        _clean_reset_identity(body.get("identity_id")),
        require_session=True,
    ).confirm(
        str(body.get("token") or "").strip()[:512],
        confirmed_account=_clean_reset_identity(body.get("confirmed_account")),
        confirmed_intent=str(body.get("confirmed_intent") or "").strip()[:128],
    )


@router.post("/reset/readback")
def reset_readback(request: Request, payload: Optional[dict[str, Any]] = Body(default=None)) -> dict[str, Any]:
    """Read current quota and reset inventory after an uncertain result."""
    body = payload if isinstance(payload, dict) else {}
    return _reset_service_for(
        request,
        _clean_profile(body.get("profile")),
        _clean_reset_identity(body.get("identity_id")),
        require_session=False,
    ).readback()


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


def _fetch_inventory_provider(
    provider: str,
    prepared: dict[str, dict[str, Any]],
    profile: Optional[str],
) -> dict[str, Any]:
    item = prepared.get(provider)
    if item:
        return _fetch_declarative_cached(
            item["definition"],
            profile=profile,
            headers=item.get("headers") or {},
        )
    row = _fetch_provider(provider)
    if provider in _SUPPORTED:
        # Kept inside the provider worker so the overview's existing thread pool
        # bounds account enrichment too (no second fan-out, no per-poll storm;
        # account reads are TTL-cached by identity).
        row = _attach_accounts(provider, row)
    return row


def _overview_scoped(body: dict[str, Any], profile: Optional[str]) -> dict[str, Any]:
    from contextvars import copy_context

    if body.get("refresh_sources"):
        _refresh_vendor_specs()
    else:
        _maybe_refresh_vendor_specs()
    loaded = _load_provider_definitions()
    prepared = _prepare_definitions(loaded)
    # Network and credential use require an approved definition. Untrusted or
    # blocked rows remain visible in the catalog, never as live providers.
    ready = {
        ident: item
        for ident, item in prepared.items()
        if item.get("trust") == "approved" and not item.get("missing")
    }
    requested_provider = _canonical(body.get("active_provider")) if body.get("active_provider") else ""
    active_model = str(body.get("active_model") or "").strip()
    inventory = _inventory()
    known = {item["id"] for item in inventory}
    for item in _definition_inventory(loaded, prepared=ready):
        if item["id"] not in known:
            inventory.append(item)
            known.add(item["id"])
    rows: dict[str, dict[str, Any]] = {}

    supported = [item["id"] for item in inventory if item.get("supported") and not item.get("definition")]
    supported.extend(item["id"] for item in inventory if item.get("definition") and item["id"] in ready)
    timings: dict[str, Optional[float]] = {}
    failures: dict[str, str] = {}
    started = time.monotonic()
    if supported:
        deadline = started + _OVERVIEW_DEADLINE_S
        pending: dict[concurrent.futures.Future[Any], str] = {}
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(supported)))
        try:
            for provider in supported:
                pending[executor.submit(copy_context().run, _fetch_inventory_provider, provider, ready, profile)] = provider
            while pending:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                done, _pending = concurrent.futures.wait(
                    list(pending), timeout=remaining, return_when=concurrent.futures.FIRST_COMPLETED
                )
                if not done:
                    break
                for future in done:
                    provider = pending.pop(future)
                    completed = time.monotonic()
                    try:
                        row = future.result()
                        timings[provider] = round((completed - started) * 1000, 1)
                    except Exception as exc:
                        definition = (ready.get(provider) or {}).get("definition")
                        if definition is not None:
                            row = _unavailable_definition_row(
                                definition,
                                state="unavailable",
                                reason=_safe_request_error(exc),
                                profile=profile,
                            )
                        else:
                            row = _unavailable(provider, _safe_request_error(exc))
                        timings[provider] = round((completed - started) * 1000, 1)
                        # A provider that failed must say so in the host log: a blank
                        # "unavailable" row with only a debug line is how a real
                        # outage hides for days.
                        failures[provider] = _failure_summary(exc)
                        log.warning(
                            "provider-usage: %s read failed after %.0fms (%s)",
                            provider, timings[provider], failures[provider],
                        )
                        log.debug("provider-usage %s failed", provider, exc_info=True)
                    rows[provider] = row
            # Anything still running at the deadline becomes an explicit slow row
            # instead of a request the desktop aborts at its own 25s cap.
            for future, provider in list(pending.items()):
                definition = (ready.get(provider) or {}).get("definition")
                reason = f"{_PROVIDER_LABELS.get(provider, provider)} did not answer within {_OVERVIEW_DEADLINE_S:g}s."
                if definition is not None:
                    row = _unavailable_definition_row(definition, state="unavailable", reason=reason, profile=profile)
                else:
                    row = _unavailable(provider, reason)
                rows[provider] = row
                timings[provider] = None
                failures[provider] = reason
                log.warning("provider-usage: %s still running at the %gs deadline", provider, _OVERVIEW_DEADLINE_S)
        finally:
            # Never hold the response open for a stuck worker; its own HTTP timeout
            # bounds it and the row is already reported as slow.
            executor.shutdown(wait=False, cancel_futures=True)

    cache_stats = _cache_stats()
    providers = []
    for item in inventory:
        provider = item["id"]
        definition = (ready.get(provider) or {}).get("definition")
        if definition is not None:
            row = rows.get(provider) or _unavailable_definition_row(
                definition,
                state="unavailable",
                reason="The definition was ready but no response was recorded.",
                profile=profile,
            )
        else:
            row = rows.get(provider) or _unavailable(provider, "No usage or balance endpoint is known for this provider.")
        row["id"] = provider
        row["label"] = item["label"]
        row["configured"] = bool(item.get("configured"))
        row["capability"] = item.get("capability", row.get("capability"))
        if not row.get("manage_links") and definition is not None:
            docs_url = _safe_https_url(definition.get("docs_url"))
            if docs_url:
                # A profile/bundled definition has no code-owned account map.
                # Its validated HTTPS docs URL is the only external link this
                # pane will show; never invent an account-management URL.
                row["manage_links"] = [{
                    "label": "Docs",
                    "product": item["label"],
                    "kind": "docs",
                    "url": docs_url,
                }]
        if not row.get("pricing"):
            row["pricing"] = _pricing_rows(provider, active_model)
        if row.get("peak") is None:
            row["peak"] = _peak_state(provider)
        if row.get("cache") is None:
            row["cache"] = cache_stats.get(provider)
        providers.append(row)

    default_provider = ""
    try:
        model_config = config = __import__("hermes_cli.config", fromlist=["load_config"]).load_config() or {}
        default_provider = _canonical((model_config.get("model") or {}).get("provider"))
    except Exception:
        pass
    active_provider = requested_provider or default_provider or (providers[0]["id"] if providers else "")
    duration_ms = round((time.monotonic() - started) * 1000)
    unavailable_ids = [item["id"] for item in providers if item.get("available") is False]
    _LAST_OVERVIEW.clear()
    _LAST_OVERVIEW.update({
        "at": _now(),
        "profile": profile or "default",
        "duration_ms": duration_ms,
        "providers": [item["id"] for item in providers],
        "unavailable": unavailable_ids,
        "failures": dict(failures),
        "timings_ms": dict(timings),
        "active_provider": active_provider,
    })
    # One line per refresh: enough to tell "nobody asked" apart from "every read failed"
    # without turning the host log into a firehose.
    log.info(
        "provider-usage overview profile=%s rows=%d unavailable=%d duration_ms=%d slow=%s failures=%s",
        profile or "default",
        len(providers),
        len(unavailable_ids),
        duration_ms,
        ",".join(f"{k}={v}ms" for k, v in timings.items() if v is None) or "none",
        "; ".join(f"{k}: {v}" for k, v in failures.items())[:400] or "none",
    )
    return {
        "version": 1,
        "definitions_version": 1,
        "fetched_at": _now(),
        "account_profile": profile or "default",
        "active": {"provider": active_provider, "model": active_model},
        "default_provider": default_provider,
        "providers": providers,
        "connections": _connection_cards(),
        "catalog": _definition_catalog(loaded, rows=rows, prepared=prepared, profile=profile),
    }
