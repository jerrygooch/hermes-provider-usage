# Reset capabilities: read-only inventory, expiry, and settings links

Status: research and design, updated 2026-11-11 for the preview/confirm
service. This document, `dashboard/reset_service.py`, and the reset/stock test
modules are the reset work added by this task. No credential, account, provider
setting, or purchase flow was touched. No reset was redeemed and no reset or
credit was bought.

Environment note: this audit ran against the stock checkout
`C:/Users/jerry/projects/provider-usage-stock-host` at
`92790b119b` with the `xai-plugin-provider-requests` test venv. A bare default
interpreter can import an older installed core whose `AccountUsageSnapshot`
lacks `identity_id`; set `PYTHONPATH` to the stock checkout before running the
compatibility suites. That is an environment mismatch, not a reset regression.

Deadline context: the safe ship is a preview -> confirm action bound to the
active account, never a one-click button or an automatic retry.

## TL;DR

1. **Codex is the only one of the three providers with a documented,
   machine-readable banked-reset inventory and a redemption API.** Official
   open-source Codex code exposes per-credit `id`, `reset_type`, `status`,
   `granted_at`, `expires_at`, `title`, and `description` from
   `GET /wham/rate-limit-reset-credits`. [S4][S5][S7]
2. **Hermes core already owns Codex redemption**, but only as an
   account-implicit `redeem_codex_reset_credit()` call with no `identity_id`
   and no `credit_id`. A concurrent `dashboard/reset_service.py` wraps it in
   preview -> confirm with profile/account binding. Keep that gate; do not add
   a one-click button or a second redemption path.
3. **Claude has a real banked "limit reset" programme.** Expiry is shown in
   Settings > Usage; no reset-inventory API is documented in the sources
   reviewed. Link only. [S8][S15]
4. **Grok/SuperGrok has scheduled weekly resets and paid extra-usage credits,
   not a documented banked-reset inventory.** Grok Bot docs document "Usage
   reset" rows with expiry, but Grok Bot is a separate Cursor-linked product;
   do not transfer that claim to `xai-oauth`. [S10][S12][S13][S16]
5. **A paid instant reset is not a banked reset**, cannot be saved, and is not
   a usage credit. Do not integrate or advertise purchase. [S2]
6. Ship read-only counts + expiry + a static settings link for Codex now;
   ship link-only fallback for Claude and Grok. Redemption is a separate,
   preview-confirmed action; there is no purchase action anywhere.

## What each surface actually offers

| Provider | Banked reset documented? | Readable inventory | Expiry | Redemption API | Safe plugin behaviour |
|---|---|---|---|---|---|
| OpenAI Codex | Yes: saved until used or expired [S1] | Yes: usage summary count, plus detailed credit rows [S4][S5] | Per credit, `expires_at` string or null [S4] | Yes: `POST .../consume` [S5] | Show count, entries, expiry, settings link. Redemption later only. |
| Anthropic Claude | Yes: "limit reset", applied by user [S8] | No reset endpoint documented in the sources reviewed; OAuth usage endpoint returns windows only | Shown in Settings > Usage, not in plugin payload [S8] | None documented | Link-only: "Check resets in Claude Settings → Usage." |
| xAI Grok / SuperGrok (`xai-oauth`) | No banked-reset inventory is documented for the consumer Grok product in the sources reviewed | Weekly window/reset date and extra-usage credits only [S10][S11] | Weekly `reset_at` is a scheduled window reset, not a credit expiry | None documented | Link-only: "Check Grok Usage"; never label the weekly reset "banked". |
| Grok Bot (separate product) | Docs say resets exist with an expiry date [S12][S13] | UI only | UI only | UI "Use reset" | Out of scope for `xai-oauth`; do not mix product docs. |

### Banked vs scheduled vs paid

- **Banked reset:** a saved, one-time reset applied by the user; it can expire.
  OpenAI says a banked reset is "a one-time Codex usage-limit reset saved to
  your account until you use it or it expires." [S1] OpenAI also distinguishes
  an automatic reset, which applies without user action and never appears as a
  saved reset, from a banked reset. [S3] Claude says a limit reset sets limits
  back to full when the user chooses to use it, and an unused reset expires at
  the listed time. [S8]
- **Scheduled reset:** the ordinary 5-hour/weekly window reset. It is already
  represented by `reset_at` on limit windows. It is not a credit, cannot be
  redeemed, and must not be counted as "banked resets".
- **Paid instant reset (OpenAI):** applies immediately, cannot be banked or
  scheduled, starts a new weekly period, and is separate from credits. [S2]
  Never show it as a banked count and never add a purchase action.
- **Usage/extra credits:** a pay-as-you-go balance, not a reset. Claude usage
  credits, OpenAI extra usage, and Grok additional-usage credit are separate
  from reset inventory. [S2][S9][S11]

## Codex: exact contract found in official open-source code

Observed against `openai/codex` commit
`e58bf8f5233b51e7cd1679d947e3028c1ed91b06` (2026-11-11). Paths and line numbers
below are pinned to that commit.

### Endpoints and auth

Official backend client paths [S5]:

- ChatGPT API style: `GET {base}/wham/usage`,
  `GET {base}/wham/rate-limit-reset-credits`,
  `POST {base}/wham/rate-limit-reset-credits/consume`.
- Codex API style: `GET {base}/api/codex/usage`,
  `GET {base}/api/codex/rate-limit-reset-credits`,
  `POST {base}/api/codex/rate-limit-reset-credits/consume`.

Hermes core already mirrors this split in
`agent/account_usage.py::_codex_backend_urls` (lines 664-670): it normalises
`https://chatgpt.com/backend-api/codex` to
`https://chatgpt.com/backend-api` and then uses `/wham/...`; other bases use
`/api/codex/...`.

The detailed fetch is authenticated with the ChatGPT/Codex OAuth credential.
Official app-server refuses it unless `auth.uses_codex_backend()` is true:
"chatgpt authentication required for rate limit reset credits". [S7] A plain
OpenAI API key is not a substitute; core's redeem path already reports HTTP
401/403 as "Reset credits require ChatGPT-account (OAuth) auth".

### Inventory payload

`RateLimitResetCreditsDetails` [S4]:

```json
{
  "available_count": 2,
  "credits": [
    {
      "id": "credit-1",
      "reset_type": "codex_rate_limits",
      "status": "available",
      "granted_at": "2026-06-17T00:00:00Z",
      "expires_at": "2026-07-17T00:00:00Z",
      "title": "Full reset",
      "description": "Reset your current usage limits"
    },
    {
      "id": "credit-2",
      "reset_type": "codex_rate_limits",
      "status": "available",
      "granted_at": "2026-06-18T00:00:00Z",
      "expires_at": null,
      "title": null,
      "description": null
    }
  ]
}
```

Field facts:

- `credits[].id`: string, stable credit id.
- `reset_type`: string; official mapper recognises `codex_rate_limits` and
  maps anything else to `Unknown`. [S7]
- `status`: string; official mapper recognises `available`, `redeeming`,
  `redeemed`; anything else becomes `Unknown`. [S7]
- `granted_at`: RFC3339 string in the backend type; app-server converts it to
  Unix seconds. [S4][S7]
- `expires_at`: RFC3339 string **or null** in the backend type. Null is the
  provider saying no expiry was reported, not a value to invent. [S4]
- `title`, `description`: optional strings. [S4]
- `available_count`: authoritative summary count. Do not replace it with
  `len(credits)` and do not subtract redeemed rows client-side. [S4]

The usage summary also carries `rate_limit_reset_credits.available_count`
(`RateLimitResetCreditsSummary`). [S4] The plugin already consumes that. The
extra field `applicable_available_count` is emitted by the live usage payload
that the plugin currently reads, but it is **not** present in the official
open-source summary/details structs. Treat it as an optional provider
extension, never as required, and never derive it.

### Detail-fetch failure behaviour

Official app-server fetches the detailed list with a 5-second timeout, and on
error, timeout, or parse failure logs a warning and falls back to the usage
summary. [S7] That is the model to copy: detail is an enhancement, never a
reason to lose the count.

### Selection and expiry ordering

Official TUI builds its redemption picker by [S6]:

1. keeping only `status == available`;
2. sorting by `expires_at.unwrap_or(i64::MAX)` ascending, i.e. earliest expiry
   first and no-expiry rows last;
3. limiting the list to `max(available_count, 0)`;
4. passing `credit_id` for an explicit row, or `None` to let the backend pick.

The official UI prints "Does not expire" for a null expiry. [S6] **Do not copy
that wording.** Null means "No expiry reported"; asserting no expiry would
invent information.

### Consume payload and outcome

Backend consume request [S5]:

```json
{ "redeem_request_id": "<uuid>", "credit_id": "<optional credit id>" }
```

App-server exposes the same operation as
`account/rateLimitResetCredit/consume` with
`{ "idempotency_key": "<string>", "credit_id": "<optional>" }`. [S7]

Response [S4][S5]:

```json
{ "code": "reset", "windows_reset": 2 }
```

`code` is one of `reset`, `nothing_to_reset`, `no_credit`,
`already_redeemed`. `windows_reset` is optional and defaults to 0. [S4]

## What Hermes core and the plugin do today

### Core

- `agent/account_usage.py::_codex_banked_resets` reads only
  `rate_limit_reset_credits.available_count` (lines 726-728).
- `_fetch_codex_account_usage_impl` performs only `GET .../usage` (lines
  809-845). It does not call the detailed inventory endpoint, so
  `snapshot.raw` contains no per-credit rows today.
- `redeem_codex_reset_credit(*, base_url=None, api_key=None, force=False)`
  (lines 927-961) performs:
  1. resolve credentials: explicit pair, else native runtime resolver, else
     `load_pool("openai-codex").select()`;
  2. `GET .../usage`;
  3. client-side guard;
  4. `POST .../consume` with a fresh UUID in `redeem_request_id` and **no**
     `credit_id`;
  5. map `{code, windows_reset}` to `CodexResetRedeemResult`.
- The guard refuses when `available <= 0`; it also refuses unless a primary or
  secondary window is exactly 100% used, unless `force=True`. It exists to
  avoid spending a full reset while most of the allowance remains (lines
  875-898).
- A 401 triggers one forced credential refresh and one retry. The UUID is
  created once, before the loop, so the retry does not double-spend (lines
  927-961).
- Result fields: `status`, `message`, `available_count` (remaining),
  `windows_reset`, and `redeemed` property (lines 860-872).

### Owner and account semantics (the blocker)

- CLI `/usage reset` refuses unless the active provider is
  `openai-codex`, then calls `redeem_codex_reset_credit(base_url=...,
  api_key=...)` (`hermes_cli/cli_info_mixin.py`, lines 633-661).
- Messaging `/usage reset` is a **control**, not a read: `command_verdict`
  classifies `usage reset` as `control` because only bare `/usage` is in
  `_READ_ARGUMENTS` (`gateway/session_commands.py`, lines 89-95 and 137-144).
  The gateway forwards it to the owner, and a local viewer cannot execute it
  (`hermes_cli/gateway_chat_commands.py`, `_usage`).
- Redemption has **no `identity_id`, no `account_id`, and no `credit_id`**.
  The account is whichever credential the resolver or pool `select()` returns.
  It does not prove it matches the row the user is looking at.
- Provider-wide `_fetch_codex()` also fetches without an identity. The plugin
  row does not stamp the snapshot identity. With more than one pooled Codex
  account, the count is therefore ambiguous and must not be presented as
  belonging to a named account.
- Per-account Codex rows use `_serialize_snapshot()`, which has no Codex raw
  branch and therefore no `reset_credits` at all. `_ACCOUNT_ROW_KEYS` allows
  `reset_credits` if present, but today only the provider-wide `_fetch_codex()`
  path fills it.

**Consequence:** do not add a desktop Redeem button until core accepts an
identity-scoped redemption and echoes the account it used. A button that
silently redeems another pool account's credit is worse than no button.

### Plugin

- `dashboard/plugin_api.py::_fetch_codex`, in the `rate_limit_reset_credits`
  block (lines 740-748 when observed at 11:40; a concurrent worker has since
  shifted the file), preserves only:
  ```python
  {"available": int(banked or 0), "applicable": int(applicable_banked or 0)}
  ```
  It drops detailed rows and turns a missing `applicable_available_count`
  into 0. That can read as "0 usable now" when the provider said nothing.
- `desktop/plugin.js`, lines 1681-1686, renders one line:
  `Banked resets: N saved, M usable now`.
- It renders on the overview and expanded rows at lines 1779 and 1835. There
  is no link and no expiry.
- Existing tests pin the exact two-field dict
  (`tests/test_credential_migration_parity.py`, line 411). An additive change
  must update that assertion; do not silently keep it.

### In-flight redemption service (observed, not authored here)

At 11:58-12:05 CST the worktree also contained an untracked
`dashboard/reset_service.py` plus `tests/test_reset_service.py`, and the
concurrent worker wired routes into `dashboard/plugin_api.py`. Read-only
inspection shows the service is already the right shape for a Codex-only
redemption:

- `summary()` is read-only and returns the exact account's count, applicable
  count, expiry state, exhausted state, and windows.
- `preview()` re-reads the active account, verifies profile scope, compares
  its non-secret identity and count to what the caller echoed, and issues a
  two-minute, single-use confirmation token. This is a **point-in-time
  re-check, not an atomic binding**: core redemption remains account-implicit,
  so a credential change between the re-check and the redeem call cannot be
  excluded.
- `confirm(token, confirmed_account=..., confirmed_intent=...)` re-checks
  session, profile, identity, intent, and availability fingerprint, takes a
  per-account non-blocking lock, calls core exactly once, and requires an
  independent same-identity readback with a lower banked-reset count before it
  reports success. A missing count, an unchanged count, a readback error, or a
  different identity is `uncertain` / `ok: false` / `credit_consumed:
  "unknown"`; it is never retried automatically.
- `readback()` returns current quota/inventory after an uncertain result; it
  never redeems. The plugin exposes it as `POST /reset/readback`.
- It does **not** enumerate the credential pool, so it cannot promise a
  blanket multi-account refusal. It refuses only when the active snapshot's
  identity differs from the previewed identity. With several pooled Codex
  credentials, core still chooses the credential at redemption time and this
  service cannot prove which one it used.
- It never accepts a URL, credit selector, force flag, or purchase flag.
- It currently sets `expiration_reported: false` and uses a note that the
  usage response does not expose per-credit expiry. That is correct for the
  current core payload. If Phase 0 lands, extend this service to read the
  exact entries; do not leave a stale "no expiry" note.

The confirmation token is a random capability whose SHA-256 digest is the
only form stored server-side. Session binding is an equality check against a
server-derived session id. That is cryptographic only when the host supplies
an authenticated session context. On stock Desktop with no such context,
`_reset_session_id` falls back to a digest of the local client tuple
(host/user-agent): that is a single-local-user convenience boundary, not
authentication. Never expose these routes on a network listener.

This service covers the consent and owner/account problem for the account
currently resolved. It does **not** make a multi-account Redeem button safe.
Do not relax the identity check until core gains identity-scoped redemption
and echoes the account it used.

## Proposed additive row schema

Keep everything under the existing `reset_credits` object. This avoids adding
a new top-level key to `_ACCOUNT_ROW_KEYS` and keeps per-account filtering
unchanged.

```json
{
  "reset_credits": {
    "available": 2,
    "applicable": 1,
    "entries": [
      {
        "id": "credit-1",
        "reset_type": "codex_rate_limits",
        "status": "available",
        "granted_at": "2026-06-17T00:00:00Z",
        "expires_at": "2026-07-17T00:00:00Z",
        "title": "Full reset",
        "description": "Reset your current usage limits"
      }
    ],
    "inventory_source": "reset_credits_api",
    "manage_url": "https://chatgpt.com/codex/settings/usage",
    "manage_label": "Open Codex usage settings",
    "detail": null
  }
}
```

### Field provenance and rules

| Field | Source | Rule |
|---|---|---|
| `available` | `rate_limit_reset_credits.available_count` | Integer or `null`. Never default a missing value to 0. |
| `applicable` | `rate_limit_reset_credits.applicable_available_count` | Integer or `null`. Optional provider extension, not in official OSS types. Never derive; never default to 0. |
| `entries` | `GET .../rate-limit-reset-credits` -> `credits[]` | Copy only the seven official fields. `null` when the call failed or the build lacks the seam. |
| `entries[].expires_at` | payload `expires_at` | RFC3339 string or `null`. Validate; invalid -> `null` + `detail` note. Never synthesise from `reset_at`, plan renewal, or grant date. |
| `entries[].status` | payload `status` | Keep the raw string; map known statuses to labels in the UI, show unknown verbatim. |
| `inventory_source` | plugin constant | One of `reset_credits_api`, `usage_summary`, `provider_settings_only`. |
| `manage_url` | static allowlist in backend | Never a provider-supplied URL. |
| `manage_label` | static copy | Short, provider-specific. |
| `detail` | plugin copy | Explains missing inventory/expiry; never contains a token, account id, or provider error body. |

Do **not** add a top-level `reset_expires_at`. Expiry belongs to each credit.
Any "earliest expiry" is a UI computation over `entries` and must be labelled
as such; it is not a stored fact.

### Link-only shape

For a provider that has resets but no readable inventory:

```json
{
  "reset_credits": {
    "available": null,
    "applicable": null,
    "entries": null,
    "inventory_source": "provider_settings_only",
    "manage_url": "https://claude.ai/settings/usage",
    "manage_label": "Open Claude usage settings",
    "detail": "Claude shows limit resets in Settings > Usage; this plugin cannot read them."
  }
}
```

This is the user-preferred "check resets even when we cannot read inventory"
case. `available: null` is essential: it renders as unknown, not zero.

## UI copy matrix

| State | Primary line | Secondary line | Action |
|---|---|---|---|
| Codex, count > 0, entries present | `2 banked resets` | `1 usable now · earliest reported expiry Jul 17, 2026` | `Open Codex usage settings` |
| Codex, count > 0, entries unavailable | `2 banked resets` | `Expiry details are not available from this core build.` | same link |
| Codex, count = 0 | `No banked resets reported` | `Expiry does not apply.` (or omit) | same link |
| Codex, count missing | `Banked resets not reported` | `The provider did not return a reset count.` | same link |
| Codex API-key auth | `Banked resets need a ChatGPT sign-in` | `Reset credits are not available to plain API-key auth.` | same link |
| Codex detail request failed | `2 banked resets` | `Expiry details couldn't be loaded; the count is still current.` | same link |
| Entry `expires_at: null` | `No expiry reported` | never `Does not expire` | same link |
| Entry timestamp is in the past but status is `available` | `Expiry passed Jul 1, 2026` | `Provider still lists this credit as available.` | same link |
| Claude (any) | `Reset details aren't exposed here` | `Claude shows limit resets and expiry in Settings > Usage.` | `Open Claude usage settings` |
| Grok/SuperGrok (any) | `Reset details aren't exposed here` | `Grok shows weekly usage and credits in its dashboard.` | `Open Grok dashboard` |
| Unconfigured provider | no reset block | existing connection card | existing connect flow |

Never say "0 saved" when `available` is `null`. Never say "expires" from a
scheduled `reset_at`. Never say "expires soon" without an explicit
`expires_at`; if a warning is wanted, derive it only from that value and show
the date.

## Expiry-aware selection (proposed, not implemented)

Read-only display and redemption selection are different problems.

- **Display:** list every `entries[]` row in the complete view; sort by
  `expires_at` ascending with null last, matching the official TUI, and label
  the first row "earliest reported expiry". Do not hide other rows.
- **Redemption:** keep selection server-side and deterministic. Once core
  accepts a `credit_id`, the server should filter `status == "available"`,
  sort by `expires_at` ascending with null last, choose exactly one, and bind
  that id into the preview token. The confirmation must show the chosen
  credit's title and expiry.
- **Do not** let a client choose a credit by index or by a payload string.
  If core cannot accept `credit_id`, leave selection to the backend as it does
  today; do not fake a choice in the UI.
- **Do not** order by `granted_at` or by plan renewal. Only an explicit
  `expires_at` may influence expiry order; null-expiry rows go last.
- If the count and the available-entry list disagree, do not silently pick
  from the shorter list. Refuse the redemption or fall back to the
  server-selected path, and show the mismatch.

## Implementation patch plan (small, read-only first)

Do this only after the active provider-card worker releases
`dashboard/plugin_api.py` and `desktop/plugin.js`. The core seam is a separate
worktree (`C:/Users/jerry/AppData/Local/hermes/worktrees/provider-usage-core-seams`).

### Phase 0 — core read-only detail fetch

File: `agent/account_usage.py`, in `_fetch_codex_account_usage_impl`.

1. After the successful usage `GET`, call
   `_codex_backend_urls(resolved_base_url)[1]` with the same headers,
   `timeout=5.0`.
2. Wrap in `try/except Exception`; on any failure leave details as `None`.
   Do not retry, do not refresh, do not surface an error to the row.
3. If the body is a dict, attach it to `snapshot.raw` under
   `rate_limit_reset_credits_details`, passed through `_sanitized_raw`.
4. Do not add a new normalized snapshot field. The plugin already treats
   `snapshot.raw` as the decoded-body seam for Codex.
5. On the per-identity path, the `api_key`/`base_url` pair already belongs to
   that identity; use the same pair for the detail call. This is what makes
   the inventory account-correct.
6. Tests: detail 200, detail 429/timeout fallback, raw has no credentials,
   per-identity detail uses that identity's credential.

Estimated change: ~20 lines plus 3 tests. No write, no mutation, no new
credential read.

### Phase 1 — plugin backend

File: `dashboard/plugin_api.py`.

1. Add a static map near `_PROVIDER_LABELS`:
   ```python
   _RESET_SETTINGS = {
       "openai-codex": ("https://chatgpt.com/codex/settings/usage", "Open Codex usage settings"),
       "anthropic": ("https://claude.ai/settings/usage", "Open Claude usage settings"),
       "xai-oauth": ("https://grok.com/dashboard", "Open Grok dashboard"),
   }
   ```
2. Add pure helpers:
   - `_reset_entry(raw)` -> seven-field dict or `None`; validate RFC3339 for
     `granted_at`/`expires_at`; keep raw status string.
   - `_reset_credits_block(payload)` -> the additive object; reads
     `rate_limit_reset_credits` and
     `rate_limit_reset_credits_details.credits`.
3. Replace the `rate_limit_reset_credits` block in `_fetch_codex` with the
   helper. Preserve `available`/`applicable` as `int | None`; do not coerce
   missing to 0.
4. Set `inventory_source` to `reset_credits_api` only when at least one entry
   was actually parsed; otherwise `usage_summary` when a count exists.
5. Add a shared `_codex_row(snapshot)` used by both `_fetch_codex()` and a new
   Codex branch in `_serialize_snapshot()`, so per-account rows get the same
   reset block and `_stamp_snapshot` identity. Keep `_ACCOUNT_ROW_KEYS`
   unchanged.
6. In `_fetch_anthropic()` and `_fetch_xai()`, attach the link-only block from
   `_RESET_SETTINGS`; do not add a network call.
7. No new REST route in this phase.

Estimated change: ~60 lines plus tests. No mutation.

### Phase 2 — UI

File: `desktop/plugin.js`.

1. Add `ResetCreditsPanel({ row, complete })` near the existing inline block.
2. Replace the inline `row?.reset_credits` span (lines 1681-1686 when
   observed) with `jsx(ResetCreditsPanel, { row, complete })`.
3. Render an anchor:
   `jsx('a', { href: reset.manage_url, target: '_blank', rel: 'noopener noreferrer', ... })`.
   Keep the URL allowlist in the backend; optionally re-check it against a
   front-end map so a compromised payload cannot inject a link.
4. Render `available === null` as unknown, never 0. Render entries only in
   `complete` view; overview shows count + earliest reported expiry + link.
5. Do not render a redemption button in this phase.

Estimated change: ~50 lines plus render tests. No mutation.

### Phase 3 — redemption (already in progress; integrate, do not duplicate)

`dashboard/reset_service.py` already implements the preview/confirm design.
Do not add a second redemption route or a one-click button. The remaining
work is integration and, only if the product needs it, a core extension.

1. The concurrent worker has already added the routes at 12:05:
   `POST /reset/summary`, `POST /reset/preview`, `POST /reset/confirm`, and
   `POST /reset/readback`, with body fields `profile`, `identity_id`, `token`,
   `confirmed_account`, and `confirmed_intent`. Do not add a second set.
   Review one discrepancy before shipping: `reset_service.py`'s docstring says
   profile, identity, and session should be **server-derived**, while the route
   currently accepts `profile` and `identity_id` from the JSON body and hashes
   dashboard auth headers/cookies for the session. For a single-user local
   dashboard this is a local-user trust boundary, not authentication: the body
   identity is compared with the active snapshot before any preview or spend,
   but it is **not** constrained to an enumerated credential pool. Never expose
   these routes on a public listener. No route accepts a URL, provider label,
   credential, credit id, force flag, or purchase flag.
2. Keep the **server-selected** credit. Do not add `credit_id` until
   `redeem_codex_reset_credit` accepts an identity-scoped selector and can
   prove the credit belongs to that account. A client-supplied id without that
   proof is an account-spend vulnerability.
3. If multi-account targeting becomes a requirement: add
   `identity_id: Optional[str] = None` to `redeem_codex_reset_credit`, resolve
   it through `_account_usage_entry` as `fetch_account_usage` does, and echo
   `identity_id`/`account_id` in `CodexResetRedeemResult`. Only then can the
   service assert a caller-selected account, and only for the exact verified
   identity. Until then it cannot promise which pool credential core selects.
4. Preserve the single UUID across the 401 retry. Do not retry a redemption
   after an uncertain response; read back and reconcile.
5. Extend the service summary with `entries`/expiry only after Phase 0. If
   entries are shown at preview, bind their ids and the earliest expiry into
   the availability fingerprint so a changed inventory invalidates the token.
6. UI: one confirmation naming the account label, count, and (when available)
   credit title/expiry; warning that a full reset restores both 5-hour and
   weekly windows and cannot be undone. No "remember my choice". No purchase
   link. Never auto-redeem on load, refresh, schedule, or retry.

Provider account-state mutation still requires a separate, specific user
consent. Research and tests here do not call the real redemption path.

## Official settings URLs (verified 2026-11-11)

| Provider | URL | Evidence |
|---|---|---|
| Codex | `https://chatgpt.com/codex/settings/usage` | Codex web settings path; HTTP 200 with no redirect on 2026-11-11, and the returned app shell contains the `codex/settings` route. Path only, no guessed query string. [S14] |
| Claude | `https://claude.ai/settings/usage` | Explicit href in the official "What is a limit reset?" article. [S8][S15] Unauthenticated curl gets HTTP 403 from edge protection; the link itself is the official destination. |
| Grok | `https://grok.com/dashboard` | Official xAI manage page: "Open Usage in the sidebar at grok.com/dashboard." [S11][S16] Unauthenticated curl redirects to `accounts.x.ai/check-login` with `return_to=/dashboard`, which confirms the target path. |

Do not guess query-string deep links such as `?s=...`. Do not use
`https://chatgpt.com/codex/cloud/settings/usage` as the primary link; it also
resolves, but the canonical Codex settings path is the one above.

**Link caveat:** these links open the provider's web account, which may not be
the Hermes profile or pooled account the row describes. Label the action
"Open ... settings" and never claim the page is showing "your" resets for this
row unless the row carries a verified account label. For a multi-account pool,
the link is a convenience only; the in-plugin count and identity are the
authoritative display.

## Unavailable / degraded wording

- **No count, provider has resets:** "Reset details aren't exposed here.
  <Provider> shows them in its own settings." Link.
- **Codex count but no detail:** "Banked resets: N. Expiry details are not
  available from this core build." Link. Do not guess expiry.
- **Codex detail 429/5xx/timeout:** same as above; the count remains. Official
  app-server treats detail as best-effort with a 5-second timeout. [S7]
- **Codex API-key auth:** "Banked resets need a ChatGPT sign-in." Link.
- **`available: 0` and no entries:** "No banked resets reported." Do not show
  an empty list as an error.
- **Entries present but count mismatch:** show the authoritative count and the
  list, with "Provider reports N available; list has M rows." Do not reconcile.
- **Null expiry:** "No expiry reported." Never "never expires".
- **Past expiry but status available:** "Expiry passed <date>; provider still
  lists it as available." Do not hide or auto-delete.

## Acceptance tests

Current parser supports only the count fields, so
`tests/test_reset_metadata_contract.py` tests only behaviour that exists today
and invariants that must survive the additive change:

1. reported `available`/`applicable` integers are preserved;
2. absent reset block stays `None`;
3. explicit zero stays zero;
4. synthetic detailed payload does not mutate input or change the counts;
5. no expiry-like key is created when the payload has none;
6. if an `entries` field is added later, every entry id/expiry must come from
   the payload, never from a derived value.

The proposed `entries`/`manage_url` acceptance is specified above but is not
asserted as passing today. When Phase 1 lands, add tests for:

- exact seven-field mapping and unknown status passthrough;
- null `expires_at` preserved as null;
- invalid `expires_at` does not become a date;
- count/entries mismatch is preserved;
- detail failure leaves the count and sets `detail`;
- per-account row carries the same identity as its snapshot;
- link URLs are the static allowlist, not payload strings.

## Sources

[S1] OpenAI Help, "How resets work in Codex."
https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work
Accessed 2026-11-11.

[S2] OpenAI Help, "Paid weekly Work and Codex rate limit resets."
https://help.openai.com/en/articles/20001507-paid-weekly-work-and-codex-rate-limit-resets
Accessed 2026-11-11.

[S3] OpenAI Help, "Response speed and usage resets in Work and Codex."
https://help.openai.com/en/articles/20001596-response-speed-and-usage-resets-in-work-and-codex
Accessed 2026-11-11.

[S4] openai/codex, `codex-rs/backend-client/src/types.rs`, commit
`e58bf8f5233b51e7cd1679d947e3028c1ed91b06`.
https://github.com/openai/codex/blob/e58bf8f5233b51e7cd1679d947e3028c1ed91b06/codex-rs/backend-client/src/types.rs
Accessed 2026-11-11.

[S5] openai/codex, `codex-rs/backend-client/src/client/rate_limit_resets.rs`,
same commit.
https://github.com/openai/codex/blob/e58bf8f5233b51e7cd1679d947e3028c1ed91b06/codex-rs/backend-client/src/client/rate_limit_resets.rs
Accessed 2026-11-11.

[S6] openai/codex, `codex-rs/tui/src/chatwidget/reset_credits.rs`, same
commit.
https://github.com/openai/codex/blob/e58bf8f5233b51e7cd1679d947e3028c1ed91b06/codex-rs/tui/src/chatwidget/reset_credits.rs
Accessed 2026-11-11.

[S7] openai/codex,
`codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs`
and `codex-rs/app-server-protocol/src/protocol/v2/account.rs`, same commit.
https://github.com/openai/codex/blob/e58bf8f5233b51e7cd1679d947e3028c1ed91b06/codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs
https://github.com/openai/codex/blob/e58bf8f5233b51e7cd1679d947e3028c1ed91b06/codex-rs/app-server-protocol/src/protocol/v2/account.rs
Accessed 2026-11-11.

[S8] Claude Help Center, "What is a limit reset?"
https://support.claude.com/en/articles/17007452-what-is-a-limit-reset
Accessed 2026-11-11.

[S9] Claude Help Center, "Manage usage credits for paid Claude plans."
https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans
Accessed 2026-11-11.

[S10] xAI Docs, "Usage limits."
https://docs.x.ai/x-subscription/usage-limits
Accessed 2026-11-11.

[S11] xAI Docs, "Managing The X Subscription."
https://docs.x.ai/x-subscription/manage
Accessed 2026-11-11.

[S12] xAI Docs, "Settings and notifications" (Grok Bot).
https://docs.x.ai/grok-bot/settings-and-notifications
Accessed 2026-11-11.

[S13] xAI Docs, "Grok Bot for Mobile."
https://docs.x.ai/grok-bot/mobile
Accessed 2026-11-11.

[S14] Codex web settings path (usage dashboard).
https://chatgpt.com/codex/settings/usage
HTTP 200, no redirect, 2026-11-11. Official chatgpt.com host; re-verify after
Codex UI changes because this is a product path, not a documented API.

[S15] Claude Settings > Usage.
https://claude.ai/settings/usage
Official destination linked from [S8]; 2026-11-11.

[S16] Grok dashboard.
https://grok.com/dashboard
Official destination linked from [S11]; unauthenticated redirect to
`accounts.x.ai/check-login` with `return_to=/dashboard`, 2026-11-11.
